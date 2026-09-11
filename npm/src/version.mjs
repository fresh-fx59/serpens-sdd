const EDITION = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/;
const SEMVER = /^1\.(\d{4})(\d{2})(\d{2})\.(\d+)$/;

export function editionToSemver(edition) {
  const m = EDITION.exec(edition);
  if (!m) throw new Error(`invalid kit edition "${edition}", expected YYYY-MM-DD.N`);
  const [, y, mo, d, n] = m;
  return `1.${y}${mo}${d}.${Number(n)}`;
}

export function semverToEdition(version) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`invalid package version "${version}", expected 1.YYYYMMDD.N`);
  const [, y, mo, d, n] = m;
  return `${y}-${mo}-${d}.${n}`;
}
