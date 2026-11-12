import {defineConfig, esmExternalRequirePlugin} from 'vite';

export default defineConfig({
    build: {
        // The pinned Scratch GUI still parses the library with Webpack 4.
        target: 'es2017',
        // Leave class bindings intact for Webpack 4's scope hoisting and final minification.
        minify: false,
        license: {fileName: 'THIRD_PARTY_NOTICES.md'},
        lib: {
            entry: {index: 'src/index.ts', explorer: 'src/explorer.tsx'},
            formats: ['es'],
            fileName: (_format, name) => `${name}.js`
        },
        rolldownOptions: {
            // The explorer renders with the host's React; Headless Tree is bundled.
            plugins: [esmExternalRequirePlugin({external: ['react', 'react-dom']})],
            // Code both entries use; it never imports React.
            output: {chunkFileNames: 'shared-[hash].js'}
        }
    }
});
