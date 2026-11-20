const https = require('node:https'),
  http = require('node:http'),
  fs = require('node:fs');
const path = require('node:path');
const type = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};
https
  .createServer({ cert: fs.readFileSync('/cert'), key: fs.readFileSync('/key') }, (req, res) => {
    const u = new URL(req.url, 'https://t63.test');
    if (u.pathname.startsWith('/api/')) {
      const h = {
        ...req.headers,
        host: 't63.test',
        'x-forwarded-for': req.socket.remoteAddress,
        'x-forwarded-proto': 'https',
      };
      const dst = http.request(
        {
          hostname: 'api',
          port: 3000,
          method: req.method,
          path: u.pathname + u.search,
          headers: h,
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      dst.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(dst);
      return;
    }
    const h5 = u.pathname.startsWith('/h5/');
    const root = '/static/' + (h5 ? 'h5' : 'admin');
    const rel = decodeURIComponent(u.pathname.slice(h5 ? 4 : 1)) || 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + '/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('content-type', type[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  })
  .listen(443, '0.0.0.0');
