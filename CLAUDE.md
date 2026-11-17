# Nitrogen

## Version numbers

Every round of changes gets a new version number, without being asked:

- When you start making changes after the last push to `main`, bump the patch version first
  (1.0.5 → 1.0.6), so each push to `main` ships under its own version.
- Change it in both `package.json` and `src/shared/version.ts` (a test checks they match).
- Only bump the minor or major version (1.1.0, 2.0.0) when the owner asks for it.
- Mention the new version number when you report the changes or push them.
