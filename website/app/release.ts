// The version and installer paths shown across the site.
export const release = '0.4.0';
export const downloads = {
  windows: `/download/secondHand-${release}-win-x64.exe`,
  macArm: `/download/secondHand-${release}-mac-arm64.dmg`,
  macIntel: `/download/secondHand-${release}-mac-x64.dmg`,
  checksums: `/download/SHA256SUMS.txt?release=${release}`,
} as const;
