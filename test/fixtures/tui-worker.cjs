// Fixture only: EOF on a private harness-owned FIFO makes this worker exit itself.
// The harness never needs to signal a worker PID read from a file.
const fs = require('node:fs');
const fd = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
const buffer = Buffer.alloc(1);
function checkLifeline() {
  try {
    if (fs.readSync(fd, buffer, 0, 1, null) === 0) process.exit(0);
  } catch (error) {
    if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') process.exit(1);
  }
}
checkLifeline();
setInterval(checkLifeline, 50);
console.log('{}');
