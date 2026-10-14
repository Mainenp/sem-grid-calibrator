// Ignore decoder warnings (e.g. NUL bytes in TIFF ImageDescription), not errors.
// Do not use failOn: 'none': truncated or corrupt pixel data must still fail.
module.exports = Object.freeze({
  limitInputPixels: false,
  unlimited: true,
  sequentialRead: true,
  failOn: 'error'
});
