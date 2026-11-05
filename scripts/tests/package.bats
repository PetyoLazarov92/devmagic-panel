#!/usr/bin/env bats

# scripts/package.sh against a small copy of the repository with a fake
# build: npm is a stub, so nothing is downloaded and the load check is off.

setup() {
  SRC="$BATS_TEST_TMPDIR/repo"
  REAL="$BATS_TEST_DIRNAME/../.."
  mkdir -p "$SRC/scripts/bin" "$SRC/scripts/lib" "$SRC/scripts/php" "$SRC/scripts/php-compat" "$SRC/scripts/tests"
  cp "$REAL/scripts/package.sh" "$SRC/scripts/"
  cp "$REAL/scripts/lib/log.sh" "$SRC/scripts/lib/"
  printf '#!/bin/sh\necho dmp-root\n' > "$SRC/scripts/bin/dmp-root"
  printf '#!/bin/sh\necho restore\n' > "$SRC/scripts/bin/dmp-restore"
  printf '#!/bin/sh\necho wpcore\n' > "$SRC/scripts/bin/wpcore"
  printf '<?php\n' > "$SRC/scripts/php/info.php"
  printf '{}\n' > "$SRC/scripts/php-compat/composer.json"
  printf '{}\n' > "$SRC/scripts/php-compat/composer.lock"
  printf 'echo test\n' > "$SRC/scripts/tests/never.bats"
  printf '{\n  "name": "devmagic-panel",\n  "version": "9.8.7",\n  "private": true\n}\n' > "$SRC/package.json"
  printf '{}\n' > "$SRC/package-lock.json"
  printf '22\n' > "$SRC/.nvmrc"
  printf '#!/bin/sh\necho installer\n' > "$SRC/install.sh"
  printf '#!/bin/sh\necho get\n' > "$SRC/get.sh"
  printf '# readme\n' > "$SRC/README.md"
  printf '# Changelog\n' > "$SRC/CHANGELOG.md"
  printf 'MIT License\n' > "$SRC/LICENSE"
  for part in shared server web; do
    mkdir -p "$SRC/$part/dist" "$SRC/$part/src"
    printf '{"name": "@devmagic-panel/%s"}\n' "$part" > "$SRC/$part/package.json"
    printf 'source\n' > "$SRC/$part/src/index.ts"
  done
  printf 'export {};\n' > "$SRC/shared/dist/index.js"
  printf 'export {};\n' > "$SRC/server/dist/index.js"
  printf 'export {};\n' > "$SRC/server/dist/cli.js"
  printf '<html></html>\n' > "$SRC/web/dist/index.html"

  git -C "$SRC" init -q
  git -C "$SRC" add -A
  git -C "$SRC" -c user.name=Test -c user.email=test@example.com commit -qm release
  git -C "$SRC" tag v9.8.7

  # npm ci puts a marker where the dependencies would go, with the arguments it got.
  STUBS="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUBS"
  printf '#!/bin/sh\nmkdir -p node_modules/fake && echo "$*" > node_modules/fake/args\n' > "$STUBS/npm"
  chmod +x "$STUBS/npm"
  export PATH="$STUBS:$PATH"
  export DMP_PACKAGE_SKIP_CHECK=1
  OUT="$BATS_TEST_TMPDIR/out"
}

@test "a tagged checkout packs as its release, with a checksum and release.json" {
  run "$SRC/scripts/package.sh" --out "$OUT"
  [ "$status" -eq 0 ]
  [ -f "$OUT/devmagic-panel-v9.8.7.tar.gz" ]
  (cd "$OUT" && sha256sum -c devmagic-panel-v9.8.7.tar.gz.sha256)

  run tar -tzf "$OUT/devmagic-panel-v9.8.7.tar.gz"
  [[ "$output" == *"devmagic-panel-v9.8.7/install.sh"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/get.sh"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/.nvmrc"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/LICENSE"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/release.json"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/scripts/bin/dmp-root"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/scripts/php/info.php"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/scripts/php-compat/composer.lock"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/server/dist/index.js"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/web/dist/index.html"* ]]
  [[ "$output" == *"devmagic-panel-v9.8.7/node_modules/fake/args"* ]]
  # No sources, tests or anything that is not part of the running panel.
  [[ "$output" != *"/src/"* ]]
  [[ "$output" != *"scripts/tests"* ]]
  [[ "$output" != *"package.sh"* ]]

  # Only the server's production dependencies.
  tar -xzf "$OUT/devmagic-panel-v9.8.7.tar.gz" -C "$BATS_TEST_TMPDIR"
  pkg="$BATS_TEST_TMPDIR/devmagic-panel-v9.8.7"
  [[ "$(cat "$pkg/node_modules/fake/args")" == "ci --omit=dev --workspace server --include-workspace-root=false --ignore-scripts"* ]]

  # release.json says what it is and what the installer and root scripts are.
  cmp "$pkg/release.json" "$OUT/devmagic-panel-v9.8.7.json"
  json="$(cat "$pkg/release.json")"
  [[ "$json" == *'"name": "v9.8.7"'* ]]
  [[ "$json" == *'"version": "9.8.7"'* ]]
  [[ "$json" == *"\"commit\": \"$(git -C "$SRC" rev-parse HEAD)\""* ]]
  [[ "$json" == *"\"installer\": \"$(sha256sum "$SRC/install.sh" | cut -d' ' -f1)\""* ]]
  [[ "$json" == *"\"bin/dmp-root\": \"$(sha256sum "$SRC/scripts/bin/dmp-root" | cut -d' ' -f1)\""* ]]
  [[ "$json" == *"\"lib/log.sh\": \"$(sha256sum "$SRC/scripts/lib/log.sh" | cut -d' ' -f1)\""* ]]
  [[ "$json" == *"\"php/info.php\": \"$(sha256sum "$SRC/scripts/php/info.php" | cut -d' ' -f1)\""* ]]
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$pkg/release.json"
  # The staging folder is gone.
  [ -z "$(find "$OUT" -name '.stage.*')" ]
}

@test "a commit after the release is a dev build, and changed files are marked" {
  printf 'more\n' >> "$SRC/README.md"
  git -C "$SRC" -c user.name=Test -c user.email=test@example.com commit -qam later
  short="$(git -C "$SRC" rev-parse --short=7 HEAD)"
  run "$SRC/scripts/package.sh" --out "$OUT"
  [ "$status" -eq 0 ]
  [ -f "$OUT/devmagic-panel-v9.8.7-dev.$short.tar.gz" ]

  printf 'edit\n' >> "$SRC/README.md"
  run "$SRC/scripts/package.sh" --out "$OUT"
  [ "$status" -eq 0 ]
  [ -f "$OUT/devmagic-panel-v9.8.7-dev.$short.dirty.tar.gz" ]
}

@test "refuses without a build and refuses a name that is not a release" {
  rm "$SRC/web/dist/index.html"
  run "$SRC/scripts/package.sh" --out "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no web/dist/index.html: run npm run build first"* ]]

  printf '<html></html>\n' > "$SRC/web/dist/index.html"
  run "$SRC/scripts/package.sh" --out "$OUT" --name '../v1.0.0'
  [ "$status" -eq 2 ]
  [ ! -e "$OUT/devmagic-panel-../v1.0.0.tar.gz" ]
}
