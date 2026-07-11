// Compila index.src.html (JSX vía Babel) → index.html (JS listo, sin Babel)
// para que el navegador no tenga que descargar Babel (~3MB) ni compilar.
// Uso: node build.js   (con @babel/core y @babel/plugin-transform-react-jsx en /tmp)
const fs = require('fs');
const path = require('path');
const BABEL_DIR = process.env.BABEL_DIR || '/tmp/crmbuild/node_modules';
const babel = require(BABEL_DIR + '/@babel/core');

const src = fs.readFileSync(path.join(__dirname, 'index.src.html'), 'utf8');
const m = src.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!m) { console.error('No se encontró el bloque <script type="text/babel">'); process.exit(1); }

const compiled = babel.transformSync(m[1], {
  // runtime 'classic' → usa React.createElement (React global del CDN),
  // NO el runtime automático que necesitaría un bundler
  plugins: [[require(BABEL_DIR + '/@babel/plugin-transform-react-jsx'), { runtime: 'classic' }]],
  compact: false,
  comments: false,
}).code;

let out = src
  // quitar el CDN de babel-standalone (ya no hace falta)
  .replace(/\s*<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone[^"]*"><\/script>/, '')
  // sustituir el bloque JSX por el JS ya compilado
  .replace(/<script type="text\/babel">[\s\S]*?<\/script>/,
           '<script>\n' + compiled + '\n</script>');

fs.writeFileSync(path.join(__dirname, 'index.html'), out);
console.log('✅ index.html generado (', (out.length/1024).toFixed(0), 'KB, sin Babel )');
