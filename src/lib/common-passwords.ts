/**
 * The most frequently used passwords, most common first (lower case).
 *
 * Compiled from public breach statistics (SecLists "10k most common", NordPass yearly top 200),
 * plus the number/pinyin patterns that dominate Chinese-language leaks. Vulgar entries are kept on
 * purpose: people do use them, and an estimator that does not know them rates them too highly.
 * Variants written in "leet" (p@ssw0rd), with different capitalisation or reversed are recognised
 * by the estimator and need no entry of their own.
 */
const LIST =
  '123456 password 123456789 12345678 1234 qwerty123 qwerty qwerty1 12345 111111 dragon ' +
  'secret baseball 123123 football 1234567890 letmein 1234567 monkey 000000 696969 abc123 ' +
  'mustang password1 michael iloveyou shadow 11111111 master jennifer 123123123 2000 123321 ' +
  'jordan qwertyuiop superman 00000000 harley 654321 hunter fuckyou trustno1 1g2w3e4r ranger ' +
  'buster thomas 666666 tigger 1q2w3e4r5t robert soccer 987654321 fuckme 1q2w3e4r batman ' +
  'a123456 test 1qaz2wsx pass 121212 killer abcd1234 hockey asdfghjkl george 123456a charlie ' +
  '88888888 andrew michelle love 112233 sunshine q1w2e3r4t5y6 jessica asshole zxcvbnm 6969 ' +
  'princess pepper daniel aaaaaa access joshua 147258369 maggie qwerty1234 starwars silver ' +
  'qwerty12 william 123qwe dallas computer yankees 159753 ashley azerty hello amanda pokemon ' +
  'orange biteme 1234qwer freedom 1234561 888888 sexy thunder nicole 12345678910 ginger ' +
  '1qaz2wsx3edc heather 123456789a hammer 123654 summer corvette qwer1234 taylor fucker ' +
  '789456123 austin 1111 q1w2e3r4 merlin matthew 222222 golfer qwe123 cheese 7777777 martin ' +
  'asdasd chelsea admin patrick richard testing diamond qazwsx yellow asdf1234 bigdog 1314520 ' +
  '555555 asdfgh 12341234 sparky cowboy a123456789 camaro anthony liverpool matrix falcon ' +
  '123abc 7758521 bailey woaini guitar jackson password123 purple scooter phoenix 999999 ' +
  'morgan unknown tigers 1q2w3e porsche 1111111 mickey 789456 maverick pakistan cookie ' +
  '12qwaszx nascar peanut 1111111111 justin welcome 131313 aa123456 money 11223344 samantha ' +
  '159357 steelers asd123 joseph snoopy boomer whatever 147258 iceman smokey gateway naruto ' +
  'dakota jonathan cowboys eagles 102030 chicken basketball black zxcvbn please chocolate ' +
  'andrea ferrari internet knight samsung hardcore asdfasdf melissa compaq coffee booboo bitch ' +
  'blink182 johnny bulldog xxxxxx james player ncc1701 alexander wizard hannah scooby ' +
  'qazwsxedc charles 11111 junior minecraft mike changeme brandy tennis 87654321 jordan23 ' +
  'banana qq123456 monster 1qazxsw2 1234567891 123456123 12344321 babygirl butterfly lol123 ' +
  'qwert 123654789 aaaaaaaa benjamin 333333 facebook family hello123 google apple login root ' +
  'toor admin123 administrator guest user default pass123 pass1234 passwd abc12345 abc123456 ' +
  '123456abc a12345 a1234567 a12345678 5201314 520520 woaini1314 woaini520 5211314 110110 ' +
  '168168 666888 iloveyou1 wang123 zhang123 asd123456 qwe123456 zxc123 zxc123456 q123456 ' +
  'w123456 123456q 1qaz 2wsx 741852963 963852741 147852369 741852 852963 951753 13579 24680 ' +
  '1357924680 0987654321 010203 112358 314159 31415926 letmein1 welcome1 welcome123 master123 ' +
  'dragon123 monkey123 football1 baseball1 superman1 batman1 michael1 jordan1 princess1 ' +
  'sunshine1 shadow1 daniel1 killer1 secret1 secret123 love123 iloveu loveyou lovely angel ' +
  'angel1 jesus christ heaven nothing nopass none null test123 test1234 testtest temp ' +
  'temp123 temporary changeme123 newpass newpassword mypassword mypass password2 password12 ' +
  'password1234 passpass passw0rd1 qwerty12345 qwerty123456 qwer qwerqwer qweasd qweasdzxc ' +
  'qazxsw asdfjkl zxcvbnm123 asdf document adobe acrobat';

/** Password → rank (1 = most common). */
export const COMMON_PASSWORDS: ReadonlyMap<string, number> = new Map(
  LIST.split(' ').map((password, index) => [password, index + 1] as const),
);

/** Length of the longest entry: longer substrings need not be looked up. */
export const LONGEST_COMMON_PASSWORD = Math.max(...LIST.split(' ').map((entry) => entry.length));
