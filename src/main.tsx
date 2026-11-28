import { render } from 'preact';
import { App } from './app';
import { start } from './state';
import { watchViewport } from './ui/viewport';
import './styles/index.css';

// Before the first render: the layout depends on it (keyboard open, short viewport).
watchViewport();

const root = document.getElementById('app');
if (root) render(<App />, root);

// Applies the settings to the document, takes in shared and dropped files, registers the service
// worker and preloads the engine. Once; it never throws.
start();
