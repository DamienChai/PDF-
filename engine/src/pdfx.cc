// pdfx: the WebAssembly-facing wrapper around libqpdf.
//
// The module has no file system. Input bytes are pulled on demand from JavaScript through an
// LRU block cache (JsInputSource), output bytes are pushed to JavaScript in chunks (JsSink), and
// the API is a handful of C functions exchanging JSON strings. See engine/README.md.

#include <qpdf/Constants.h>
#include <qpdf/InputSource.hh>
#include <qpdf/JSON.hh>
#include <qpdf/Pipeline.hh>
#include <qpdf/QIntC.hh>
#include <qpdf/QPDF.hh>
#include <qpdf/QPDFExc.hh>
#include <qpdf/QPDFLogger.hh>
#include <qpdf/QPDFObjectHandle.hh>
#include <qpdf/QPDFWriter.hh>
#include <qpdf/QUtil.hh>
#include <qpdf/RandomDataProvider.hh>

#include <emscripten/emscripten.h>
#include <unistd.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <limits>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

// Implemented in JavaScript (engine/src/pdfx_lib.js). None of them may throw.
extern "C" {
// Copies `length` bytes starting at `offset` of input `handle` to `dest`.
// Returns the number of bytes copied, or a negative value on failure.
int pdfx_js_read(int handle, double offset, unsigned char* dest, int length);
// Takes a copy of `length` bytes at `data`. Returns 0, or a negative value on failure.
int pdfx_js_write(int handle, unsigned char const* data, int length);
void pdfx_js_progress(int handle, int percent);
}

namespace
{
    // ---------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------

    // Deliberately not derived from std::exception: qpdf turns std::exception into "damaged PDF"
    // warnings in several places, and an I/O failure must not be mistaken for a damaged file.
    struct ReadFailure
    {
    };
    struct WriteFailure
    {
    };

    // An error with one of the stable codes of EngineErrorCode (src/engine/types.ts).
    struct EngineError
    {
        std::string code;
        std::string detail;
    };

    // ---------------------------------------------------------------------------------------
    // Input: LRU block cache over the JavaScript byte source
    // ---------------------------------------------------------------------------------------

    struct CacheStats
    {
        uint64_t read_calls{0};
        uint64_t bytes_read{0};
        uint64_t evictions{0};
    };

    // Fixed-size blocks, loaded on demand and evicted least-recently-used first. A miss right
    // after a cached block is treated as a sequential scan and loads a run of blocks with one
    // JavaScript call; the run doubles each time up to `max_run`. Random access therefore costs
    // one small read per miss while copying a large stream costs few, large reads.
    class BlockCache
    {
      public:
        BlockCache(
            int handle,
            uint64_t size,
            size_t block_size,
            size_t budget_bytes,
            size_t max_read_bytes) :
            handle_(handle),
            size_(size),
            block_size_(block_size),
            block_count_((size + block_size - 1) / block_size),
            max_run_(static_cast<uint32_t>(std::max<size_t>(1, max_read_bytes / block_size)))
        {
            // Every block of a run must fit without evicting another block of the same run.
            uint64_t capacity = std::max<uint64_t>(budget_bytes / block_size, 4ULL * max_run_);
            capacity_ = static_cast<size_t>(std::min<uint64_t>(capacity, block_count_));
            slot_of_.assign(static_cast<size_t>(block_count_), -1);
            slots_.reserve(std::min<size_t>(capacity_, 1024));
        }

        uint64_t
        size() const
        {
            return size_;
        }

        size_t
        blockSize() const
        {
            return block_size_;
        }

        // Changes whenever a block pointer handed out earlier may have become invalid.
        uint64_t
        generation() const
        {
            return generation_;
        }

        bool
        failed() const
        {
            return failed_;
        }

        CacheStats const&
        stats() const
        {
            return stats_;
        }

        // Returns the data of block `index` (which must exist) and its length.
        unsigned char const*
        block(uint64_t index, size_t& length)
        {
            int32_t s = slot_of_[static_cast<size_t>(index)];
            if (s < 0) {
                s = load(index);
            }
            touch(s);
            Slot const& slot = slots_[static_cast<size_t>(s)];
            length = slot.length;
            return slot.data.get();
        }

      private:
        struct Slot
        {
            std::unique_ptr<unsigned char[]> data;
            uint64_t block{0};
            uint32_t length{0};
            uint32_t run{1};
            int32_t prev{-1};
            int32_t next{-1};
        };

        void
        unlink(int32_t s)
        {
            Slot& slot = slots_[static_cast<size_t>(s)];
            if (slot.prev >= 0) {
                slots_[static_cast<size_t>(slot.prev)].next = slot.next;
            } else {
                head_ = slot.next;
            }
            if (slot.next >= 0) {
                slots_[static_cast<size_t>(slot.next)].prev = slot.prev;
            } else {
                tail_ = slot.prev;
            }
            slot.prev = slot.next = -1;
        }

        void
        pushFront(int32_t s)
        {
            Slot& slot = slots_[static_cast<size_t>(s)];
            slot.prev = -1;
            slot.next = head_;
            if (head_ >= 0) {
                slots_[static_cast<size_t>(head_)].prev = s;
            } else {
                tail_ = s;
            }
            head_ = s;
        }

        void
        touch(int32_t s)
        {
            if (head_ != s) {
                unlink(s);
                pushFront(s);
            }
        }

        // Returns a slot that is not in the LRU list: a new one, or the least recently used.
        int32_t
        acquire()
        {
            if (slots_.size() < capacity_) {
                Slot slot;
                slot.data.reset(new unsigned char[block_size_]);
                slots_.push_back(std::move(slot));
                return static_cast<int32_t>(slots_.size() - 1);
            }
            int32_t s = tail_;
            unlink(s);
            slot_of_[static_cast<size_t>(slots_[static_cast<size_t>(s)].block)] = -1;
            ++stats_.evictions;
            return s;
        }

        // Size of the read that continues a scan whose last block is `previous` (cached).
        uint32_t
        nextRun(uint64_t previous) const
        {
            int32_t s = slot_of_[static_cast<size_t>(previous)];
            return std::min(slots_[static_cast<size_t>(s)].run * 2, max_run_);
        }

        int32_t
        load(uint64_t index)
        {
            if (failed_) {
                throw ReadFailure();
            }
            // Decide what to read: [first, first + run) always contains `index`.
            uint64_t first = index;
            uint32_t run = 1;
            bool part_of_scan = false;
            if (index > 0 && slot_of_[static_cast<size_t>(index - 1)] >= 0) {
                // Directly behind a cached block: a scan. Double the previous read. Once the
                // scan has walked off the end of a read of several blocks it is known to consume
                // what is fetched for it.
                run = nextRun(index - 1);
                scanning_ = run >= 8;
                part_of_scan = true;
            } else if (
                scanning_ && index >= scan_end_ && index - scan_end_ < max_run_ &&
                slot_of_[static_cast<size_t>(scan_end_ - 1)] >= 0) {
                // A short hop ahead of an established scan: qpdf looks at the end of a stream
                // before it copies the stream. Extend the scan up to there instead of fetching a
                // lone block that the scan would have to read again. One hop per scan step: a
                // series of hops without reading in between is sparse access, and bridging it
                // would read the whole file for nothing.
                first = scan_end_;
                run = std::max(static_cast<uint32_t>(index - first + 1), nextRun(first - 1));
                scanning_ = false;
                part_of_scan = true;
            }
            run = static_cast<uint32_t>(std::min<uint64_t>(run, block_count_ - first));
            if (part_of_scan) {
                scan_end_ = first + run;
            }

            uint64_t begin = first * block_size_;
            auto bytes = static_cast<size_t>(
                std::min<uint64_t>((first + run) * block_size_, size_) - begin);

            // A single block is read straight into its slot; a run goes through a scratch buffer
            // because the slots are not contiguous.
            int32_t single = -1;
            unsigned char* dest;
            if (run == 1) {
                single = acquire();
                dest = slots_[static_cast<size_t>(single)].data.get();
            } else {
                if (!scratch_) {
                    scratch_.reset(new unsigned char[static_cast<size_t>(max_run_) * block_size_]);
                }
                dest = scratch_.get();
            }

            ++generation_;
            ++stats_.read_calls;
            int got = pdfx_js_read(handle_, static_cast<double>(begin), dest, static_cast<int>(bytes));
            if (got < 0 || static_cast<size_t>(got) != bytes) {
                failed_ = true;
                if (single >= 0) {
                    // Keep the slot reachable so that the LRU list stays consistent.
                    slots_[static_cast<size_t>(single)].length = 0;
                    slots_[static_cast<size_t>(single)].block = first;
                    slot_of_[static_cast<size_t>(first)] = single;
                    pushFront(single);
                }
                throw ReadFailure();
            }
            stats_.bytes_read += bytes;

            for (uint32_t i = 0; i < run; ++i) {
                auto block_index = static_cast<size_t>(first + i);
                int32_t s = slot_of_[block_index];
                if (s >= 0) {
                    // Already cached (qpdf peeks at the end of a stream before copying it). The
                    // run was read across it rather than cut short, so that a scan keeps its
                    // momentum; the block just joins the run.
                    slots_[static_cast<size_t>(s)].run = run;
                    touch(s);
                    continue;
                }
                s = (run == 1) ? single : acquire();
                Slot& slot = slots_[static_cast<size_t>(s)];
                size_t offset = static_cast<size_t>(i) * block_size_;
                size_t length = std::min(block_size_, bytes - offset);
                if (run > 1) {
                    memcpy(slot.data.get(), scratch_.get() + offset, length);
                }
                slot.block = first + i;
                slot.length = static_cast<uint32_t>(length);
                slot.run = run;
                slot_of_[block_index] = s;
                pushFront(s);
            }
            return slot_of_[static_cast<size_t>(index)];
        }

        int handle_;
        uint64_t size_;
        size_t block_size_;
        uint64_t block_count_;
        uint32_t max_run_;
        size_t capacity_{0};
        std::vector<int32_t> slot_of_;
        std::vector<Slot> slots_;
        std::unique_ptr<unsigned char[]> scratch_;
        int32_t head_{-1};
        int32_t tail_{-1};
        // One past the last block of the most recent sequential read, and whether that scan has
        // proven to be dense (see load()).
        uint64_t scan_end_{0};
        bool scanning_{false};
        uint64_t generation_{0};
        bool failed_{false};
        CacheStats stats_;
    };

    // InputSource over a BlockCache. The observable behaviour (positions, last_offset, EOF
    // handling) mirrors qpdf's BufferInputSource exactly; qpdf's parser depends on those details.
    class JsInputSource final: public InputSource
    {
      public:
        JsInputSource(std::shared_ptr<BlockCache> cache, std::string name) :
            cache_(std::move(cache)),
            name_(std::move(name)),
            size_(QIntC::to_offset(cache_->size()))
        {
        }

        qpdf_offset_t
        findAndSkipNextEOL() override
        {
            requireValidPosition();
            if (pos_ >= size_) {
                last_offset = size_;
                pos_ = size_;
                return size_;
            }
            qpdf_offset_t p = pos_;
            while (p < size_) {
                size_t avail = 0;
                unsigned char const* data = window(p, avail);
                size_t i = 0;
                while (i < avail && data[i] != '\r' && data[i] != '\n') {
                    ++i;
                }
                p += QIntC::to_offset(i);
                if (i < avail) {
                    break;
                }
            }
            if (p >= size_) {
                pos_ = size_;
                return size_;
            }
            qpdf_offset_t result = p;
            pos_ = p + 1;
            while (pos_ < size_) {
                size_t avail = 0;
                unsigned char const* data = window(pos_, avail);
                if (*data != '\r' && *data != '\n') {
                    break;
                }
                ++pos_;
            }
            return result;
        }

        std::string const&
        getName() const override
        {
            return name_;
        }

        qpdf_offset_t
        tell() override
        {
            return pos_;
        }

        void
        seek(qpdf_offset_t offset, int whence) override
        {
            switch (whence) {
            case SEEK_SET:
                pos_ = offset;
                break;
            case SEEK_END:
                QIntC::range_check(size_, offset);
                pos_ = size_ + offset;
                break;
            case SEEK_CUR:
                QIntC::range_check(pos_, offset);
                pos_ += offset;
                break;
            default:
                throw std::logic_error("invalid argument to JsInputSource::seek");
            }
            if (pos_ < 0) {
                throw std::runtime_error(name_ + ": seek before beginning of buffer");
            }
        }

        void
        rewind() override
        {
            pos_ = 0;
        }

        size_t
        read(char* buffer, size_t length) override
        {
            requireValidPosition();
            if (pos_ >= size_) {
                last_offset = size_;
                return 0;
            }
            last_offset = pos_;
            size_t len = static_cast<size_t>(
                std::min<uint64_t>(static_cast<uint64_t>(size_ - pos_), length));
            size_t done = 0;
            while (done < len) {
                size_t avail = 0;
                unsigned char const* data = window(pos_ + QIntC::to_offset(done), avail);
                size_t n = std::min(avail, len - done);
                memcpy(buffer + done, data, n);
                done += n;
            }
            pos_ += QIntC::to_offset(len);
            return len;
        }

        void
        unreadCh(char) override
        {
            if (pos_ > 0) {
                --pos_;
            }
        }

      private:
        void
        requireValidPosition() const
        {
            if (pos_ < 0) {
                throw std::logic_error("JsInputSource offset < 0");
            }
        }

        // Returns the cached bytes at `offset` (0 <= offset < size) and how many follow
        // contiguously in the same block.
        unsigned char const*
        window(qpdf_offset_t offset, size_t& avail)
        {
            if (offset < win_begin_ || offset >= win_end_ || generation_ != cache_->generation()) {
                auto block_size = cache_->blockSize();
                uint64_t index = static_cast<uint64_t>(offset) / block_size;
                size_t length = 0;
                win_data_ = cache_->block(index, length);
                win_begin_ = QIntC::to_offset(index * block_size);
                win_end_ = win_begin_ + QIntC::to_offset(length);
                generation_ = cache_->generation();
                if (offset >= win_end_) {
                    // Only possible after a failed read left an empty block behind.
                    throw ReadFailure();
                }
            }
            avail = static_cast<size_t>(win_end_ - offset);
            return win_data_ + (offset - win_begin_);
        }

        std::shared_ptr<BlockCache> cache_;
        std::string name_;
        qpdf_offset_t size_;
        qpdf_offset_t pos_{0};
        unsigned char const* win_data_{nullptr};
        qpdf_offset_t win_begin_{0};
        qpdf_offset_t win_end_{0};
        uint64_t generation_{0};
    };

    // ---------------------------------------------------------------------------------------
    // Output: buffered pipeline handing chunks to JavaScript
    // ---------------------------------------------------------------------------------------

    class JsSink final: public Pipeline
    {
      public:
        // `failed` outlives the sink: it is how the caller learns, after unwinding, that an
        // exception was caused by JavaScript refusing a chunk.
        JsSink(int handle, size_t buffer_size, bool& failed) :
            Pipeline("pdfx output", nullptr),
            handle_(handle),
            capacity_(buffer_size),
            buffer_(new unsigned char[buffer_size]),
            failed_(failed)
        {
        }

        void
        write(unsigned char const* data, size_t len) override
        {
            if (len >= capacity_) {
                flush();
                emit(data, len);
                return;
            }
            if (fill_ + len > capacity_) {
                flush();
            }
            memcpy(buffer_.get() + fill_, data, len);
            fill_ += len;
        }

        void
        finish() override
        {
            flush();
        }

        uint64_t
        total() const
        {
            return total_ + fill_;
        }

      private:
        void
        flush()
        {
            if (fill_ > 0) {
                size_t n = fill_;
                fill_ = 0;
                emit(buffer_.get(), n);
            }
        }

        void
        emit(unsigned char const* data, size_t len)
        {
            static constexpr size_t max_piece = size_t{64} << 20;
            while (len > 0) {
                size_t n = std::min(len, max_piece);
                if (failed_ || pdfx_js_write(handle_, data, static_cast<int>(n)) != 0) {
                    failed_ = true;
                    throw WriteFailure();
                }
                total_ += n;
                data += n;
                len -= n;
            }
        }

        int handle_;
        size_t capacity_;
        std::unique_ptr<unsigned char[]> buffer_;
        size_t fill_{0};
        uint64_t total_{0};
        bool& failed_;
    };

    // ---------------------------------------------------------------------------------------
    // Randomness
    // ---------------------------------------------------------------------------------------

    // getentropy() is crypto.getRandomValues() under Emscripten. qpdf is built without any random
    // source of its own (see build.sh), so encryption cannot work unless this provider is set.
    class EntropyProvider final: public RandomDataProvider
    {
      public:
        void
        provideRandomData(unsigned char* data, size_t len) override
        {
            while (len > 0) {
                size_t n = std::min<size_t>(len, 256);
                if (getentropy(data, n) != 0) {
                    throw std::runtime_error("the system random number generator failed");
                }
                data += n;
                len -= n;
            }
        }
    };

    void
    initOnce()
    {
        static bool done = false;
        if (done) {
            return;
        }
        static EntropyProvider entropy;
        QUtil::setRandomDataProvider(&entropy);
        // qpdf must never print: there is no console worth writing to, and warnings are
        // returned in the response instead.
        auto logger = QPDFLogger::defaultLogger();
        logger->setInfo(logger->discard());
        logger->setWarn(logger->discard());
        logger->setError(logger->discard());
        done = true;
    }

    // ---------------------------------------------------------------------------------------
    // JSON helpers
    // ---------------------------------------------------------------------------------------

    [[noreturn]] void
    badRequest(std::string const& what)
    {
        throw EngineError{"internal", "invalid request: " + what};
    }

    std::string
    stringField(JSON const& obj, char const* key, char const* fallback = nullptr)
    {
        std::string value;
        if (obj.getDictItem(key).getString(value)) {
            return value;
        }
        if (fallback == nullptr) {
            badRequest(std::string("missing string \"") + key + "\"");
        }
        return fallback;
    }

    bool
    boolField(JSON const& obj, char const* key, bool fallback)
    {
        bool value = fallback;
        obj.getDictItem(key).getBool(value);
        return value;
    }

    uint64_t
    uintField(JSON const& obj, char const* key, uint64_t fallback)
    {
        std::string number;
        if (!obj.getDictItem(key).getNumber(number)) {
            return fallback;
        }
        char* end = nullptr;
        double value = strtod(number.c_str(), &end);
        if (end == number.c_str() || !(value >= 0) || value > 9007199254740992.0) {
            badRequest(std::string("bad number \"") + key + "\"");
        }
        return static_cast<uint64_t>(value);
    }

    int
    hexDigit(char c)
    {
        if (c >= '0' && c <= '9') {
            return c - '0';
        }
        if (c >= 'a' && c <= 'f') {
            return c - 'a' + 10;
        }
        if (c >= 'A' && c <= 'F') {
            return c - 'A' + 10;
        }
        return -1;
    }

    // Passwords travel hex-encoded so that JavaScript controls the exact bytes. qpdf takes
    // passwords as C strings, so a zero byte cannot be represented and is rejected.
    std::string
    decodeHexPassword(std::string const& hex)
    {
        if (hex.size() % 2 != 0) {
            badRequest("odd-length hex password");
        }
        std::string bytes;
        bytes.reserve(hex.size() / 2);
        for (size_t i = 0; i < hex.size(); i += 2) {
            int hi = hexDigit(hex[i]);
            int lo = hexDigit(hex[i + 1]);
            if (hi < 0 || lo < 0) {
                badRequest("non-hex character in password");
            }
            char byte = static_cast<char>((hi << 4) | lo);
            if (byte == '\0') {
                badRequest("password contains a zero byte");
            }
            bytes.push_back(byte);
        }
        return bytes;
    }

    std::vector<std::string>
    passwordList(JSON const& request)
    {
        std::vector<std::string> result;
        JSON list = request.getDictItem("passwords");
        if (list.isArray()) {
            list.forEachArrayItem([&result](JSON item) {
                std::string hex;
                if (!item.getString(hex)) {
                    badRequest("password is not a string");
                }
                result.push_back(decodeHexPassword(hex));
            });
        }
        return result;
    }

    char*
    toCString(std::string const& s)
    {
        auto* out = static_cast<char*>(malloc(s.size() + 1));
        if (out == nullptr) {
            return nullptr;
        }
        memcpy(out, s.c_str(), s.size() + 1);
        return out;
    }

    // ---------------------------------------------------------------------------------------
    // Opening documents
    // ---------------------------------------------------------------------------------------

    struct IoOptions
    {
        int handle{0};
        uint64_t size{0};
        size_t block_bytes{64 * 1024};
        size_t cache_bytes{64 * 1024 * 1024};
        size_t max_read_bytes{4 * 1024 * 1024};
        size_t sink_bytes{1024 * 1024};
    };

    IoOptions
    ioOptions(JSON const& request)
    {
        IoOptions io;
        io.handle = static_cast<int>(uintField(request, "handle", 0));
        std::string size;
        if (!request.getDictItem("size").getNumber(size)) {
            badRequest("missing \"size\"");
        }
        io.size = uintField(request, "size", 0);
        if (io.size > static_cast<uint64_t>(std::numeric_limits<qpdf_offset_t>::max())) {
            badRequest("size out of range");
        }
        auto clamp = [](uint64_t v, uint64_t lo, uint64_t hi) {
            return static_cast<size_t>(std::min(std::max(v, lo), hi));
        };
        // The lower bounds are far below anything useful; tests use them to force block
        // boundaries and evictions onto small files.
        io.block_bytes = clamp(uintField(request, "blockBytes", io.block_bytes), 64, 4u << 20);
        io.max_read_bytes = clamp(
            uintField(request, "maxReadBytes", io.max_read_bytes), io.block_bytes, 64u << 20);
        io.cache_bytes =
            clamp(uintField(request, "cacheBytes", io.cache_bytes), io.block_bytes, 1u << 30);
        io.sink_bytes = clamp(uintField(request, "sinkBytes", io.sink_bytes), 16, 16u << 20);
        return io;
    }

    // What an operation leaves behind for the error mapping once its stack is unwound.
    struct IoState
    {
        std::shared_ptr<BlockCache> cache;
        bool write_failed{false};
    };

    std::shared_ptr<BlockCache>
    openCache(IoOptions const& io, IoState& state)
    {
        state.cache = std::make_shared<BlockCache>(
            io.handle, io.size, io.block_bytes, io.cache_bytes, io.max_read_bytes);
        return state.cache;
    }

    enum class Access { none, locked, user, owner, both };

    char const*
    accessName(Access a)
    {
        switch (a) {
        case Access::none:
            return "none";
        case Access::locked:
            return "locked";
        case Access::user:
            return "user";
        case Access::owner:
            return "owner";
        case Access::both:
            return "both";
        }
        return "none";
    }

    struct Document
    {
        // The open document. When `access` is locked this is the instance whose open attempt
        // failed on the password check: its encryption parameters are valid, nothing else is.
        std::unique_ptr<QPDF> pdf;
        Access access{Access::none};
        bool opens_without_password{false};
        // Index into the candidate list of the password that opened it; -1 if none was needed.
        int matched_index{-1};
        std::vector<std::string> warnings;
    };

    std::unique_ptr<QPDF>
    newQpdf()
    {
        auto pdf = std::make_unique<QPDF>();
        pdf->setSuppressWarnings(true);
        return pdf;
    }

    void
    collectWarnings(QPDF& pdf, std::vector<std::string>& into)
    {
        for (auto const& w: pdf.getWarnings()) {
            into.emplace_back(w.what());
        }
    }

    Access
    accessOf(QPDF& pdf)
    {
        if (!pdf.isEncrypted()) {
            return Access::none;
        }
        bool user = pdf.userPasswordMatched();
        bool owner = pdf.ownerPasswordMatched();
        return user && owner ? Access::both : owner ? Access::owner : Access::user;
    }

    // Tries to open with one password. Returns false if (and only if) the password is wrong.
    bool
    tryOpen(QPDF& pdf, std::shared_ptr<BlockCache> const& cache, std::string const& password)
    {
        try {
            pdf.processInputSource(
                std::make_shared<JsInputSource>(cache, "input"), password.c_str());
            return true;
        } catch (QPDFExc& e) {
            if (e.getErrorCode() == qpdf_e_password) {
                return false;
            }
            throw;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Traces of encryption in a file that lost its trailer
    // ---------------------------------------------------------------------------------------

    // The trailer is the only place that says a file is encrypted. When it is gone (typically a
    // download that stopped early) qpdf rebuilds one around the catalog it finds, and an encrypted
    // file comes back as an unencrypted one whose strings and streams are still ciphertext.
    // TraceScanner reads the raw bytes for what the trailer would have said, so that such a file
    // is refused while an unencrypted file with the same damage is still repaired.
    constexpr char lost_trailer_warning[] =
        "unable to find trailer dictionary while recovering damaged file";

    bool
    trailerWasLost(std::vector<std::string> const& warnings)
    {
        return std::any_of(warnings.begin(), warnings.end(), [](std::string const& w) {
            return w.find(lost_trailer_warning) != std::string::npos;
        });
    }

    // One sequential pass over the input in windows of `step` bytes. Every position is examined
    // in a window that also holds `context` bytes before and after it, which is as far as the
    // scanner looks around a match. Memory use does not depend on the size of the file.
    class TraceScanner
    {
      public:
        explicit TraceScanner(std::shared_ptr<BlockCache> const& cache) :
            source_(cache, "input"),
            size_(cache->size())
        {
        }

        // Describes the first trace of encryption, or returns an empty string if there is none:
        //  - an /Encrypt entry (the trailer keyword is misspelt, or the cut is behind it);
        //  - an encryption dictionary of the standard security handler;
        //  - a stream whose data cannot be what its first filter produces. This is what is left
        //    when the cut also took the encryption dictionary, which most writers put last.
        std::string
        run()
        {
            std::vector<unsigned char> window(step + 2 * context);
            for (uint64_t core = 0; core < size_; core += step) {
                uint64_t begin = core > context ? core - context : 0;
                uint64_t end = std::min<uint64_t>(size_, core + step + context);
                auto length = static_cast<size_t>(end - begin);
                source_.seek(QIntC::to_offset(begin), SEEK_SET);
                if (source_.read(reinterpret_cast<char*>(window.data()), length) != length) {
                    throw ReadFailure();
                }
                data_ = window.data();
                length_ = length;
                at_end_ = end == size_;
                auto first = static_cast<size_t>(core - begin);
                auto last = static_cast<size_t>(std::min<uint64_t>(core + step, size_) - begin);
                for (size_t i = first; i < last; ++i) {
                    char const* what = nullptr;
                    if (data_[i] == '/') {
                        if (nameAt(i, "/Encrypt")) {
                            what = "an /Encrypt entry";
                        } else if (nameAt(i, "/Standard") && encryptionDictionaryAt(i)) {
                            what = "an encryption dictionary";
                        }
                    } else if (data_[i] == 's' && encryptedStreamAt(i)) {
                        what = "stream data that does not match its filter";
                    }
                    if (what != nullptr) {
                        return std::string(what) + " at offset " + std::to_string(begin + i);
                    }
                }
            }
            return {};
        }

      private:
        static constexpr size_t step = size_t{1} << 20;
        static constexpr size_t context = size_t{16} << 10;

        enum class Leading { unknown, zlib, jpeg, jpeg2000, text };

        static bool
        isSpace(unsigned char c)
        {
            return c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '\f' || c == '\0';
        }

        static bool
        endsName(unsigned char c)
        {
            return isSpace(c) || strchr("()<>[]{}/%", c) != nullptr;
        }

        bool
        bytesAt(size_t i, std::string_view literal) const
        {
            return i + literal.size() <= length_ &&
                memcmp(data_ + i, literal.data(), literal.size()) == 0;
        }

        // True if the name `literal` (with its slash) starts at `i` and ends there too.
        bool
        nameAt(size_t i, std::string_view literal) const
        {
            if (!bytesAt(i, literal)) {
                return false;
            }
            size_t next = i + literal.size();
            return next < length_ ? endsName(data_[next]) : at_end_;
        }

        bool
        hasName(size_t from, size_t to, std::string_view literal) const
        {
            for (size_t i = from; i + literal.size() <= to; ++i) {
                if (data_[i] == '/' && nameAt(i, literal)) {
                    return true;
                }
            }
            return false;
        }

        size_t
        skipSpaceBackwards(size_t i) const
        {
            while (i > 0 && isSpace(data_[i - 1])) {
                --i;
            }
            return i;
        }

        size_t
        skipSpace(size_t i, size_t limit) const
        {
            while (i < limit && isSpace(data_[i])) {
                ++i;
            }
            return i;
        }

        // `i` is at "/Standard". True if it is the value of /Filter in an object that also has
        // /O and /U, i.e. the encryption dictionary of the standard security handler.
        bool
        encryptionDictionaryAt(size_t i) const
        {
            size_t key_end = skipSpaceBackwards(i);
            if (key_end < 7 || !bytesAt(key_end - 7, "/Filter")) {
                return false;
            }
            size_t from = i > context ? i - context : 0;
            for (size_t k = i; k >= from + 3; --k) {
                if (bytesAt(k - 3, "obj")) {
                    from = k;
                    break;
                }
            }
            size_t to = std::min(length_, i + context);
            for (size_t k = i; k + 6 <= to; ++k) {
                if (bytesAt(k, "endobj")) {
                    to = k;
                    break;
                }
            }
            return hasName(from, to, "/O") && hasName(from, to, "/U");
        }

        // What the data of a stream with the dictionary [from, to) has to begin with.
        Leading
        leadingBytesFor(size_t from, size_t to) const
        {
            size_t names = 0;
            for (size_t i = from; i < to; ++i) {
                if (data_[i] != '/') {
                    continue;
                }
                ++names;
                if (!nameAt(i, "/Filter")) {
                    continue;
                }
                // The first filter is the one the raw data is encoded with.
                size_t value = skipSpace(i + 7, to);
                if (value < to && data_[value] == '[') {
                    value = skipSpace(value + 1, to);
                }
                size_t end = value;
                while (end < to && (end == value || !endsName(data_[end]))) {
                    ++end;
                }
                std::string_view filter(reinterpret_cast<char const*>(data_ + value), end - value);
                if (filter == "/FlateDecode" || filter == "/Fl") {
                    return Leading::zlib;
                }
                if (filter == "/DCTDecode" || filter == "/DCT") {
                    return Leading::jpeg;
                }
                if (filter == "/JPXDecode") {
                    return Leading::jpeg2000;
                }
                if (filter == "/ASCII85Decode" || filter == "/A85" ||
                    filter == "/ASCIIHexDecode" || filter == "/AHx") {
                    return Leading::text;
                }
                return Leading::unknown;
            }
            // No filter. A dictionary with nothing but /Length belongs to a content stream or a
            // CMap, which are text; anything else (images, fonts, colour profiles) may be binary.
            return names == 1 && hasName(from, to, "/Length") ? Leading::text : Leading::unknown;
        }

        // `i` is at "stream". True if this is the keyword that starts the data of a stream object
        // and the data cannot be what the stream's first filter produces.
        bool
        encryptedStreamAt(size_t i) const
        {
            if (!bytesAt(i, "stream") || (i >= 3 && bytesAt(i - 3, "end"))) {
                return false;
            }
            size_t data = i + 6;
            if (bytesAt(data, "\n")) {
                data += 1;
            } else if (bytesAt(data, "\r\n")) {
                data += 2;
            } else {
                return false;
            }
            size_t dict_end = skipSpaceBackwards(i);
            if (dict_end < 2 || !bytesAt(dict_end - 2, ">>")) {
                return false;
            }
            // The dictionary starts right behind the "obj" keyword of this object.
            size_t lowest = dict_end > context ? dict_end - context : 0;
            size_t dict_begin = 0;
            bool found = false;
            for (size_t k = dict_end; k >= lowest + 3 && !found; --k) {
                if (bytesAt(k - 3, "obj")) {
                    dict_begin = skipSpace(k, dict_end);
                    found = bytesAt(dict_begin, "<<");
                }
            }
            if (!found) {
                return false;
            }
            Leading leading = leadingBytesFor(dict_begin, dict_end);

            size_t available = length_ - data;
            for (std::string_view empty: {"endstream", "\nendstream", "\r\nendstream", "\rendstream"}) {
                if (bytesAt(data, empty)) {
                    return false;
                }
            }
            unsigned char const* d = data_ + data;
            switch (leading) {
            case Leading::unknown:
                return false;
            case Leading::zlib:
                // RFC 1950: deflate with a window of at most 32 KiB, and a header checksum.
                return available >= 2 &&
                    !((d[0] & 0x0f) == 8 && (d[0] >> 4) <= 7 && ((d[0] << 8) | d[1]) % 31 == 0);
            case Leading::jpeg:
                return available >= 2 && !(d[0] == 0xff && d[1] == 0xd8);
            case Leading::jpeg2000:
                return available >= 4 && memcmp(d, "\x00\x00\x00\x0c", 4) != 0 &&
                    memcmp(d, "\xff\x4f\xff\x51", 4) != 0;
            case Leading::text:
                for (size_t k = 0; k < std::min<size_t>(available, 8); ++k) {
                    if (!(d[k] == '\t' || d[k] == '\n' || d[k] == '\f' || d[k] == '\r' ||
                          (d[k] >= 0x20 && d[k] <= 0x7e))) {
                        return true;
                    }
                }
                return false;
            }
            return false;
        }

        JsInputSource source_;
        uint64_t size_;
        unsigned char const* data_{nullptr};
        size_t length_{0};
        bool at_end_{false};
    };

    Document
    openDocument(std::shared_ptr<BlockCache> const& cache, std::vector<std::string> const& candidates)
    {
        Document doc;
        doc.pdf = newQpdf();
        if (tryOpen(*doc.pdf, cache, "")) {
            doc.access = accessOf(*doc.pdf);
            doc.opens_without_password = true;
            if (doc.access == Access::user) {
                // The empty user password opens it. A supplied password is only interesting if it
                // turns out to be the owner password.
                for (size_t i = 0; i < candidates.size(); ++i) {
                    auto pdf = newQpdf();
                    if (tryOpen(*pdf, cache, candidates[i]) && pdf->ownerPasswordMatched()) {
                        doc.pdf = std::move(pdf);
                        doc.access = accessOf(*doc.pdf);
                        doc.matched_index = static_cast<int>(i);
                        break;
                    }
                }
            }
        } else {
            doc.access = Access::locked;
            for (size_t i = 0; i < candidates.size(); ++i) {
                auto pdf = newQpdf();
                if (tryOpen(*pdf, cache, candidates[i])) {
                    doc.pdf = std::move(pdf);
                    doc.access = accessOf(*doc.pdf);
                    doc.matched_index = static_cast<int>(i);
                    break;
                }
            }
        }
        collectWarnings(*doc.pdf, doc.warnings);
        if (doc.access == Access::none && trailerWasLost(doc.warnings)) {
            std::string trace = TraceScanner(cache).run();
            if (!trace.empty()) {
                throw EngineError{
                    "damaged",
                    "the trailer is lost and the rest shows signs of encryption (" + trace +
                        "); it cannot be decrypted without the trailer"};
            }
        }
        return doc;
    }

    // ---------------------------------------------------------------------------------------
    // Describing documents
    // ---------------------------------------------------------------------------------------

    char const*
    methodName(QPDF::encryption_method_e method)
    {
        switch (method) {
        case QPDF::e_none:
            return "none";
        case QPDF::e_rc4:
            return "rc4";
        case QPDF::e_aes:
            return "aesv2";
        case QPDF::e_aesv3:
            return "aesv3";
        case QPDF::e_unknown:
            break;
        }
        return "unknown";
    }

    JSON
    describeEncryption(QPDF& pdf)
    {
        int R = 0;
        int P = 0;
        int V = 0;
        QPDF::encryption_method_e stream = QPDF::e_unknown;
        QPDF::encryption_method_e string_method = QPDF::e_unknown;
        QPDF::encryption_method_e file = QPDF::e_unknown;
        if (!pdf.isEncrypted(R, P, V, stream, string_method, file)) {
            return JSON::makeNull();
        }
        if (V < 4) {
            stream = string_method = file = QPDF::e_rc4;
        }

        // The /Encrypt dictionary is never encrypted itself and was already read by qpdf, so
        // looking at it is safe even when no password matched. The key length rules are qpdf's
        // own (QPDF_encryption.cc), i.e. the length that is actually used for decryption.
        auto dict = pdf.getTrailer().getKey("/Encrypt");
        int key_bits = 128;
        if (V <= 1) {
            key_bits = 40;
        } else if (V == 4) {
            key_bits = 128;
        } else if (V == 5) {
            key_bits = 256;
        } else if (dict.isDictionary() && dict.getKey("/Length").isInteger()) {
            int length = dict.getKey("/Length").getIntValueAsInt();
            if (length % 8 == 0 && length >= 40 && length <= 128) {
                key_bits = length;
            }
        }
        bool encrypt_metadata = true;
        if (V >= 4 && dict.isDictionary() && dict.getKey("/EncryptMetadata").isBool()) {
            encrypt_metadata = dict.getKey("/EncryptMetadata").getBoolValue();
        }

        JSON permissions = JSON::makeDictionary();
        permissions.addDictionaryMember(
            "print",
            JSON::makeString(
                pdf.allowPrintHighRes() ? "full" : pdf.allowPrintLowRes() ? "low" : "none"));
        permissions.addDictionaryMember("modify", JSON::makeBool(pdf.allowModifyOther()));
        permissions.addDictionaryMember("extract", JSON::makeBool(pdf.allowExtractAll()));
        permissions.addDictionaryMember("annotate", JSON::makeBool(pdf.allowModifyAnnotation()));
        permissions.addDictionaryMember("fillForms", JSON::makeBool(pdf.allowModifyForm()));
        permissions.addDictionaryMember("assemble", JSON::makeBool(pdf.allowModifyAssembly()));
        permissions.addDictionaryMember("accessibility", JSON::makeBool(pdf.allowAccessibility()));

        JSON result = JSON::makeDictionary();
        result.addDictionaryMember("revision", JSON::makeInt(R));
        result.addDictionaryMember("version", JSON::makeInt(V));
        result.addDictionaryMember("rawPermissions", JSON::makeInt(P));
        result.addDictionaryMember("keyBits", JSON::makeInt(key_bits));
        result.addDictionaryMember("streamMethod", JSON::makeString(methodName(stream)));
        result.addDictionaryMember("stringMethod", JSON::makeString(methodName(string_method)));
        result.addDictionaryMember("fileMethod", JSON::makeString(methodName(file)));
        result.addDictionaryMember("encryptMetadata", JSON::makeBool(encrypt_metadata));
        result.addDictionaryMember("permissions", permissions);
        return result;
    }

    // "1.7" < "2.0", "1.10" > "1.9"
    bool
    versionLess(std::string const& a, std::string const& b)
    {
        int a_major = 0, a_minor = 0, b_major = 0, b_minor = 0;
        sscanf(a.c_str(), "%d.%d", &a_major, &a_minor);
        sscanf(b.c_str(), "%d.%d", &b_major, &b_minor);
        return a_major != b_major ? a_major < b_major : a_minor < b_minor;
    }

    JSON
    stringArray(std::vector<std::string> const& items)
    {
        // A badly damaged file can produce thousands of warnings; the first ones tell the story.
        static constexpr size_t max_items = 50;
        JSON array = JSON::makeArray();
        for (size_t i = 0; i < items.size() && i < max_items; ++i) {
            array.addArrayElement(JSON::makeString(items[i]));
        }
        return array;
    }

    JSON
    describeStats(BlockCache const& cache)
    {
        JSON stats = JSON::makeDictionary();
        stats.addDictionaryMember(
            "readCalls", JSON::makeInt(static_cast<long long>(cache.stats().read_calls)));
        stats.addDictionaryMember(
            "bytesRead", JSON::makeInt(static_cast<long long>(cache.stats().bytes_read)));
        stats.addDictionaryMember(
            "evictions", JSON::makeInt(static_cast<long long>(cache.stats().evictions)));
        return stats;
    }

    struct Description
    {
        JSON json;
        size_t page_count{0};
    };

    Description
    describeDocument(Document& doc, BlockCache const& cache)
    {
        QPDF& pdf = *doc.pdf;
        bool locked = doc.access == Access::locked;
        Description d;
        d.json = JSON::makeDictionary();
        d.json.addDictionaryMember("fileSize", JSON::makeInt(static_cast<long long>(cache.size())));
        d.json.addDictionaryMember("encrypted", JSON::makeBool(pdf.isEncrypted()));
        d.json.addDictionaryMember("access", JSON::makeString(accessName(doc.access)));
        d.json.addDictionaryMember(
            "opensWithoutPassword", JSON::makeBool(doc.opens_without_password));
        d.json.addDictionaryMember("matchedIndex", JSON::makeInt(doc.matched_index));
        d.json.addDictionaryMember("encryption", describeEncryption(pdf));

        std::string version = pdf.getPDFVersion();
        if (locked) {
            // Nothing but the header and the encryption dictionary can be read without the key.
            d.json.addDictionaryMember("pdfVersion", JSON::makeString(version));
            d.json.addDictionaryMember("extensionLevel", JSON::makeNull());
            d.json.addDictionaryMember("pageCount", JSON::makeNull());
            d.json.addDictionaryMember("linearized", JSON::makeNull());
        } else {
            // The catalog may declare a later version than the header.
            auto catalog_version = pdf.getRoot().getKey("/Version");
            if (catalog_version.isName()) {
                std::string v = catalog_version.getName().substr(1);
                if (versionLess(version, v)) {
                    version = v;
                }
            }
            d.page_count = pdf.getAllPages().size();
            d.json.addDictionaryMember("pdfVersion", JSON::makeString(version));
            d.json.addDictionaryMember("extensionLevel", JSON::makeInt(pdf.getExtensionLevel()));
            d.json.addDictionaryMember(
                "pageCount", JSON::makeInt(static_cast<long long>(d.page_count)));
            d.json.addDictionaryMember("linearized", JSON::makeBool(pdf.isLinearized()));
            collectWarnings(pdf, doc.warnings);
        }
        d.json.addDictionaryMember(
            "warningCount", JSON::makeInt(static_cast<long long>(doc.warnings.size())));
        d.json.addDictionaryMember("warnings", stringArray(doc.warnings));
        return d;
    }

    // ---------------------------------------------------------------------------------------
    // Operations
    // ---------------------------------------------------------------------------------------

    JSON
    inspect(JSON const& request, IoState& state)
    {
        IoOptions io = ioOptions(request);
        auto cache = openCache(io, state);
        Document doc = openDocument(cache, passwordList(request));
        JSON result = describeDocument(doc, *cache).json;
        result.addDictionaryMember("stats", describeStats(*cache));
        return result;
    }

    qpdf_r3_print_e
    printPermission(std::string const& value)
    {
        if (value == "full") {
            return qpdf_r3p_full;
        }
        if (value == "low") {
            return qpdf_r3p_low;
        }
        if (value == "none") {
            return qpdf_r3p_none;
        }
        badRequest("bad print permission");
    }

    void
    applyEncryption(QPDFWriter& writer, JSON const& options)
    {
        if (!options.isDictionary()) {
            badRequest("missing \"encrypt\"");
        }
        std::string algorithm = stringField(options, "algorithm");
        std::string user = decodeHexPassword(stringField(options, "user"));
        std::string owner = decodeHexPassword(stringField(options, "owner"));
        if (owner.empty()) {
            badRequest("empty owner password");
        }
        bool accessibility = boolField(options, "accessibility", true);
        bool extract = boolField(options, "extract", true);
        bool assemble = boolField(options, "assemble", true);
        bool annotate = boolField(options, "annotate", true);
        bool fill_forms = boolField(options, "fillForms", true);
        bool modify = boolField(options, "modify", true);
        bool encrypt_metadata = boolField(options, "encryptMetadata", true);
        qpdf_r3_print_e print = printPermission(stringField(options, "print", "full"));

        if (algorithm == "aes-256") {
            writer.setR6EncryptionParameters(
                user.c_str(),
                owner.c_str(),
                accessibility,
                extract,
                assemble,
                annotate,
                fill_forms,
                modify,
                print,
                encrypt_metadata);
        } else if (algorithm == "aes-128") {
            writer.setR4EncryptionParametersInsecure(
                user.c_str(),
                owner.c_str(),
                accessibility,
                extract,
                assemble,
                annotate,
                fill_forms,
                modify,
                print,
                encrypt_metadata,
                true);
        } else {
            badRequest("unknown algorithm \"" + algorithm + "\"");
        }
    }

    JSON
    process(JSON const& request, IoState& state)
    {
        IoOptions io = ioOptions(request);
        std::string operation = stringField(request, "operation");
        bool decrypt = operation == "decrypt";
        if (!decrypt && operation != "encrypt") {
            badRequest("unknown operation \"" + operation + "\"");
        }
        std::string streams = stringField(request, "streams", "preserve");
        bool compress = streams == "compress";
        if (!compress && streams != "preserve") {
            badRequest("unknown stream mode \"" + streams + "\"");
        }
        bool linearize = boolField(request, "linearize", false);

        auto cache = openCache(io, state);
        auto candidates = passwordList(request);
        Document doc = openDocument(cache, candidates);
        if (doc.access == Access::locked) {
            throw EngineError{candidates.empty() ? "password-required" : "password-incorrect", ""};
        }
        if (decrypt && doc.access == Access::none) {
            throw EngineError{"not-encrypted", ""};
        }
        Description input = describeDocument(doc, *cache);

        // QPDFWriter copies the trailer it is given and fills in /Size only where the key exists.
        // A trailer that qpdf made up while recovering has none, and without this the output
        // would lack a required entry.
        QPDFObjectHandle trailer = doc.pdf->getTrailer();
        if (!trailer.hasKey("/Size")) {
            trailer.replaceKey("/Size", QPDFObjectHandle::newInteger(0));
        }

        int handle = io.handle;
        int last_percent = -1;
        JsSink sink(handle, io.sink_bytes, state.write_failed);
        QPDFWriter writer(*doc.pdf);
        writer.setOutputPipeline(&sink);
        if (compress) {
            writer.setStreamDataMode(qpdf_s_compress);
            writer.setObjectStreamMode(qpdf_o_generate);
        } else {
            // Stream data is copied byte for byte (apart from the cipher) and objects stay in the
            // containers they came in.
            writer.setStreamDataMode(qpdf_s_preserve);
            writer.setObjectStreamMode(qpdf_o_preserve);
        }
        writer.setLinearization(linearize);
        // PDF/A requires a line end before "endstream". It costs one byte per stream and keeps a
        // file that was conforming before it got encrypted conforming after decryption.
        writer.setNewlineBeforeEndstream(true);
        if (decrypt) {
            writer.setPreserveEncryption(false);
        } else {
            applyEncryption(writer, request.getDictItem("encrypt"));
        }
        writer.registerProgressReporter(
            std::make_shared<QPDFWriter::FunctionProgressReporter>([handle, &last_percent](int p) {
                if (p != last_percent) {
                    last_percent = p;
                    pdfx_js_progress(handle, p);
                }
            }));
        writer.write();
        sink.finish();

        std::vector<std::string> write_warnings;
        collectWarnings(*doc.pdf, write_warnings);
        doc.warnings.insert(doc.warnings.end(), write_warnings.begin(), write_warnings.end());

        JSON result = JSON::makeDictionary();
        result.addDictionaryMember("input", input.json);
        result.addDictionaryMember(
            "outputSize", JSON::makeInt(static_cast<long long>(sink.total())));
        result.addDictionaryMember(
            "pageCount", JSON::makeInt(static_cast<long long>(input.page_count)));
        result.addDictionaryMember(
            "warningCount", JSON::makeInt(static_cast<long long>(doc.warnings.size())));
        result.addDictionaryMember("warnings", stringArray(doc.warnings));
        result.addDictionaryMember("stats", describeStats(*cache));
        return result;
    }

    // ---------------------------------------------------------------------------------------
    // Error mapping
    // ---------------------------------------------------------------------------------------

    std::string
    errorResponse(std::string const& code, std::string const& detail)
    {
        JSON error = JSON::makeDictionary();
        error.addDictionaryMember("code", JSON::makeString(code));
        error.addDictionaryMember("detail", JSON::makeString(detail));
        JSON response = JSON::makeDictionary();
        response.addDictionaryMember("ok", JSON::makeBool(false));
        response.addDictionaryMember("error", error);
        return response.unparse();
    }

    // True if the input has no "%PDF-" marker in its first kilobyte, i.e. it is some other kind of
    // file rather than a PDF that got damaged.
    bool
    lacksPdfHeader(BlockCache& cache)
    {
        try {
            JsInputSource source(std::shared_ptr<BlockCache>(&cache, [](BlockCache*) {}), "input");
            char head[1024 + 5];
            size_t n = source.read(head, sizeof(head));
            static constexpr char marker[] = "%PDF-";
            return std::search(head, head + n, marker, marker + 5) == head + n;
        } catch (...) {
            return false;
        }
    }

    std::string
    mapQpdfError(QPDFExc const& e, BlockCache* cache)
    {
        switch (e.getErrorCode()) {
        case qpdf_e_password:
            // Only reachable when writing; opening handles wrong passwords itself.
            return errorResponse("password-incorrect", e.what());
        case qpdf_e_unsupported:
            return errorResponse("unsupported-encryption", e.what());
        case qpdf_e_damaged_pdf:
        case qpdf_e_pages:
        case qpdf_e_object:
        case qpdf_e_linearization:
            if (cache != nullptr && lacksPdfHeader(*cache)) {
                return errorResponse("not-pdf", e.what());
            }
            return errorResponse("damaged", e.what());
        case qpdf_e_system:
            return errorResponse("read-failed", e.what());
        default:
            return errorResponse("internal", e.what());
        }
    }

    template <typename Body>
    char*
    guarded(char const* request_json, Body body)
    {
        IoState state;
        std::string response;
        try {
            try {
                initOnce();
                JSON request = JSON::parse(request_json);
                if (!request.isDictionary()) {
                    badRequest("not an object");
                }
                JSON result = body(request, state);
                if (state.cache && state.cache->failed()) {
                    // qpdf swallowed the failure somewhere and carried on with partial data.
                    throw ReadFailure();
                }
                JSON ok = JSON::makeDictionary();
                ok.addDictionaryMember("ok", JSON::makeBool(true));
                ok.addDictionaryMember("result", result);
                response = ok.unparse();
            } catch (...) {
                // An I/O failure outranks whatever qpdf made of it.
                if (state.cache && state.cache->failed()) {
                    throw ReadFailure();
                }
                if (state.write_failed) {
                    throw WriteFailure();
                }
                throw;
            }
        } catch (EngineError const& e) {
            response = errorResponse(e.code, e.detail);
        } catch (ReadFailure const&) {
            response = errorResponse("read-failed", "reading the input failed");
        } catch (WriteFailure const&) {
            response = errorResponse("write-failed", "the output could not be stored");
        } catch (QPDFExc const& e) {
            response = mapQpdfError(e, state.cache.get());
        } catch (std::bad_alloc const&) {
            response = "{\"ok\":false,\"error\":{\"code\":\"out-of-memory\",\"detail\":\"\"}}";
        } catch (std::length_error const& e) {
            response = errorResponse("out-of-memory", e.what());
        } catch (std::exception const& e) {
            response = errorResponse("internal", e.what());
        } catch (...) {
            response = errorResponse("internal", "unknown exception");
        }
        return toCString(response);
    }
} // namespace

extern "C" {

// Request:  {handle, size, passwords: [hex...], cacheBytes?, blockBytes?, maxReadBytes?}
// Response: {ok: true, result: {...}} | {ok: false, error: {code, detail}}
// The returned string must be released with pdfx_free(). A null return means out of memory.
EMSCRIPTEN_KEEPALIVE char*
pdfx_inspect(char const* request_json)
{
    return guarded(
        request_json, [](JSON const& request, IoState& state) { return inspect(request, state); });
}

// Request: the inspect fields plus
//   {operation: "decrypt" | "encrypt", streams?: "preserve" | "compress", linearize?: bool,
//    encrypt?: {algorithm: "aes-256" | "aes-128", user: hex, owner: hex, print, modify, extract,
//               annotate, fillForms, assemble, accessibility, encryptMetadata}}
EMSCRIPTEN_KEEPALIVE char*
pdfx_process(char const* request_json)
{
    return guarded(
        request_json, [](JSON const& request, IoState& state) { return process(request, state); });
}

EMSCRIPTEN_KEEPALIVE void
pdfx_free(char* response)
{
    free(response);
}

// Static JSON: versions of the linked libraries.
EMSCRIPTEN_KEEPALIVE char const*
pdfx_version()
{
    static std::string const version = "{\"qpdf\":\"" + QPDF::QPDFVersion() + "\",\"zlib\":\"" +
        PDFX_ZLIB_VERSION + "\",\"jpeg\":\"" + PDFX_JPEG_VERSION + "\",\"api\":1}";
    return version.c_str();
}

} // extern "C"
