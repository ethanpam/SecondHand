// The version and installer paths shown across the site.
export const release = '0.5.1';
export const downloads = {
  windows: `/download/secondHand-${release}-win-x64.exe`,
  macArm: `/download/secondHand-${release}-mac-arm64.dmg`,
  macIntel: `/download/secondHand-${release}-mac-x64.dmg`,
  checksums: `/download/SHA256SUMS.txt?release=${release}`,
} as const;

// Advance only after the three Library installers and their checksums are verified.
export const libraryRelease = '0.5.1';
export const libraryDownloads = {
  windows: `/download/secondHand-library-${libraryRelease}-win-x64.exe`,
  macArm: `/download/secondHand-library-${libraryRelease}-mac-arm64.dmg`,
  macIntel: `/download/secondHand-library-${libraryRelease}-mac-x64.dmg`,
  checksums: `/download/SHA256SUMS-library.txt?release=${libraryRelease}`,
} as const;
