import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbDir = path.join(__dirname, 'database');

const PORT = 3000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  // Safe decode URI to support files with spaces/special characters
  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(req.url);
  } catch (e) {
    decodedUrl = req.url;
  }

  // Clean raw file paths (strip queries and hashes)
  let cleanPath = decodedUrl.split('?')[0].split('#')[0];
  if (cleanPath === '/' || cleanPath === '') {
    cleanPath = '/index.html';
  }

  // Custom REST API for real physical file caching in the /database directory
  if (cleanPath === '/api/songs') {
    try {
      fs.mkdirSync(dbDir, { recursive: true });
    } catch (err) {
      console.warn("Ensure database folder exists warning:", err.message);
    }

    if (req.method === 'GET') {
      fs.readdir(dbDir, (err, files) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Failed to access physical database folder: ' + err.message }));
          return;
        }

        let songsMap = new Map();
        let jsonFiles = files.filter(f => f.endsWith('.json'));
        
        let songsCount = jsonFiles.length;
        if (songsCount === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, songs: [] }));
          return;
        }

        let loadedCount = 0;
        const processDone = () => {
          loadedCount++;
          if (loadedCount === songsCount) {
            const allSongs = Array.from(songsMap.values());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, songs: allSongs }));
          }
        };

        // First handle songs_db.json to establish baselines, then individual song overrides
        jsonFiles.sort((a, b) => {
          if (a === 'songs_db.json') return -1;
          if (b === 'songs_db.json') return 1;
          return a.localeCompare(b);
        });

        jsonFiles.forEach(file => {
          const filePath = path.join(dbDir, file);
          fs.readFile(filePath, 'utf8', (readErr, content) => {
            if (!readErr) {
              try {
                const parsed = JSON.parse(content);
                if (file === 'songs_db.json') {
                  if (Array.isArray(parsed)) {
                    parsed.forEach(s => {
                      if (s && s.id) songsMap.set(s.id, s);
                    });
                  }
                } else {
                  if (parsed && parsed.id) {
                    songsMap.set(parsed.id, parsed);
                  }
                }
              } catch (e) {
                console.error(`Error parsing JSON file ${file}:`, e);
              }
            }
            processDone();
          });
        });
      });
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const songsList = JSON.parse(body);
          if (!Array.isArray(songsList)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Expected an array of songs' }));
            return;
          }

          // 1. Write the main list to songs_db.json
          const dbPath = path.join(dbDir, 'songs_db.json');
          fs.writeFile(dbPath, JSON.stringify(songsList, null, 2), (err) => {
            if (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Failed to write songs_db.json: ' + err.message }));
              return;
            }

            // 2. Clean up old orphaned files starting with song_
            fs.readdir(dbDir, (readDirErr, files) => {
              if (!readDirErr) {
                const activeIds = new Set(songsList.map(s => s.id));
                files.forEach(file => {
                  if (file.startsWith('song_') && file.endsWith('.json')) {
                    let isOrphaned = true;
                    for (let activeId of activeIds) {
                      if (file.includes(activeId)) {
                        isOrphaned = false;
                        break;
                      }
                    }
                    if (isOrphaned) {
                      fs.unlink(path.join(dbDir, file), (unlinkErr) => {
                        if (unlinkErr) console.warn(`Could not delete orphaned file ${file}:`, unlinkErr);
                      });
                    }
                  }
                });
              }
            });

            // 3. Write individual files for non-preloaded songs
            const customSongs = songsList.filter(s => !s.isPreloaded);
            if (customSongs.length === 0) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
              return;
            }

            let writeCount = 0;
            let hasError = false;
            customSongs.forEach(song => {
              const safeTitle = song.title.toLowerCase().replace(/[^a-z0-9]+/g, '_');
              const fileName = `song_${safeTitle}_${song.id}.json`;
              const filePath = path.join(dbDir, fileName);

              fs.writeFile(filePath, JSON.stringify(song, null, 2), (writeErr) => {
                if (writeErr) {
                  console.error(`Failed to write individual file ${fileName}:`, writeErr);
                  hasError = true;
                }
                writeCount++;
                if (writeCount === customSongs.length) {
                  if (hasError) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Completed main index save, but failed to write some individual track files.' }));
                  } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                  }
                }
              });
            });
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Malformed JSON payload: ' + e.message }));
        }
      });
      return;
    }
  }

  const filePath = path.join(process.cwd(), cleanPath);

  // Prevention against directory traversal attacks
  if (!filePath.startsWith(process.cwd())) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #09090c; color: #a3a3a3; min-height: 100vh;">
          <h1 style="color: #34d399;">404 Not Found</h1>
          <p>The requested file could not be locate: ${cleanPath}</p>
          <a href="/" style="color: #10b981; text-decoration: none; font-weight: bold;">Go Back to SovereignPrompter</a>
        </div>
      `);
      return;
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    // Support Partial Content Range headers for seamless audio scrubbing / multi-buffered seeking
    const range = req.headers.range;
    if (range && (extname === '.mp3' || extname === '.wav')) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;

      if (start >= stats.size || end >= stats.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        res.end();
        return;
      }

      const chunksize = (end - start) + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      });

      fileStream.pipe(res);
    } else {
      // Standard static file response
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
});

// Ensure database folder exists on startup
try {
  fs.mkdirSync(dbDir, { recursive: true });
} catch (e) {
  console.error("Could not ensure database directory exists on startup:", e);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SovereignPrompter Server listening on port ${PORT}`);
});
