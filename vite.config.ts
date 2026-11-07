import {defineConfig} from 'vite';

export default defineConfig({
    build: {
        // The pinned Scratch GUI still parses the library with Webpack 4.
        target: 'es2017',
        lib: {entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js'}
    }
});
