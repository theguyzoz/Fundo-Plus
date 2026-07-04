import fs   from 'fs';
import path from 'path';

function minifyCSS(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*([{};:,>~+])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/;\s*}/g, '}')
    .trim();
}

function minifyJS(js) {
  // Safe JS minifier: strips comments but preserves strings/template literals
  let result = '';
  let i = 0;
  const len = js.length;

  while (i < len) {
    const ch = js[i];

    // Single-quoted string
    if (ch === "'") {
      let str = ch; i++;
      while (i < len) {
        if (js[i] === '\\') { str += js[i] + js[i+1]; i += 2; continue; }
        str += js[i];
        if (js[i] === "'") { i++; break; }
        i++;
      }
      result += str;
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      let str = ch; i++;
      while (i < len) {
        if (js[i] === '\\') { str += js[i] + js[i+1]; i += 2; continue; }
        str += js[i];
        if (js[i] === '"') { i++; break; }
        i++;
      }
      result += str;
      continue;
    }

    // Template literal
    if (ch === '`') {
      let str = ch; i++;
      let depth = 0;
      while (i < len) {
        if (js[i] === '\\') { str += js[i] + js[i+1]; i += 2; continue; }
        if (js[i] === '$' && js[i+1] === '{') { depth++; str += js[i] + js[i+1]; i += 2; continue; }
        if (js[i] === '{' && depth > 0) { depth++; str += js[i++]; continue; }
        if (js[i] === '}' && depth > 0) { depth--; str += js[i++]; continue; }
        str += js[i];
        if (js[i] === '`' && depth === 0) { i++; break; }
        i++;
      }
      result += str;
      continue;
    }

    // Line comment //
    if (ch === '/' && js[i+1] === '/') {
      while (i < len && js[i] !== '\n') i++;
      continue;
    }

    // Block comment /* */
    if (ch === '/' && js[i+1] === '*') {
      i += 2;
      while (i < len && !(js[i] === '*' && js[i+1] === '/')) i++;
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  return result
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

function minifyHTML(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style>([\s\S]*?)<\/style>/gi,
      (_, css) => `<style>${minifyCSS(css)}</style>`)
    .replace(/<script>([\s\S]*?)<\/script>/gi,
      (_, js)  => `<script>${minifyJS(js)}</script>`)
    .replace(/[ \t]*\n[ \t]*/g, '')
    .replace(/>\s{2,}</g, '> ')
    .replace(/\s{2,}</g, ' <')
    .trim();
}

export function serveMinified(filePath) {
  const cache = { html: null, mtime: 0 };
  return (req, res) => {
    try {
      const stat = fs.statSync(filePath);
      if (!cache.html || stat.mtimeMs !== cache.mtime) {
        const raw   = fs.readFileSync(filePath, 'utf8');
        cache.html  = minifyHTML(raw);
        cache.mtime = stat.mtimeMs;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(cache.html);
    } catch (e) {
      console.error('[minify]', filePath, e.message);
      res.status(500).send('Internal Server Error');
    }
  };
}

export function obfuscateMiddleware(staticDir) {
  return (req, res, next) => {
    let reqPath = req.path;
    if (!reqPath.endsWith('.html')) {
      if (reqPath.endsWith('/')) reqPath += 'index.html';
      else reqPath += '.html';
    }
    const filePath = path.join(staticDir, reqPath);
    if (!fs.existsSync(filePath)) return next();
    return serveMinified(filePath)(req, res);
  };
}

export function serveObfuscated(filePath) {
  return serveMinified(filePath);
}
