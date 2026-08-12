{
  lib,
  buildNpmPackage,
  gitMinimal,
  makeWrapper,
  nodejs_24,
  src,
}:

let
  agentBadgeDirectory = ".agent-badge";
  agentBadgeDirectories = [
    ".github/agent-badge"
    agentBadgeDirectory
  ];
  package = lib.importJSON ../packages/agent-badge/package.json;
in
buildNpmPackage {
  pname = "agent-badge-unwrapped";
  inherit (package) version;

  inherit src;

  npmDepsHash = "sha256-M5eCFQWPgsZJxrKXkB7ChJcgHZHgQL9rIeSD7Aa2Yko=";

  nodejs = nodejs_24;
  npmFlags = [ "--ignore-scripts" ];
  npmBuildScript = "build";

  nativeBuildInputs = [ makeWrapper ];
  nativeCheckInputs = [ gitMinimal ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck

    npm test -- --run \
      packages/core/src/attribution/attribution-engine.test.ts \
      packages/core/src/attribution/home-normalization.test.ts \
      packages/core/src/diagnostics/doctor.test.ts \
      packages/core/src/init/preflight.test.ts \
      packages/core/src/init/runtime-wiring.test.ts \
      packages/core/src/init/scaffold.test.ts \
      packages/core/src/providers/grok/grok-adapter.test.ts \
      packages/core/src/providers/provider-directories.test.ts \
      packages/core/src/publish/readme-badge.test.ts \
      packages/core/src/repo/agent-badge-directory.test.ts \
      packages/core/src/scan/refresh-cache.test.ts \
      packages/agent-badge/src/commands/config.test.ts \
      packages/agent-badge/src/commands/doctor.test.ts \
      packages/agent-badge/src/commands/status.test.ts \
      packages/agent-badge/src/commands/uninstall.test.ts
    test "$(node packages/agent-badge/dist/cli/main.js --version)" = "$version"

    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --ignore-scripts
    test -e node_modules/@legotin/agent-badge-core

    mkdir -p "$out/bin" "$out/libexec/agent-badge"
    cp -r node_modules packages "$out/libexec/agent-badge/"

    makeWrapper ${lib.getExe nodejs_24} "$out/bin/agent-badge" \
      --add-flags "$out/libexec/agent-badge/packages/agent-badge/dist/cli/main.js"

    runHook postInstall
  '';

  meta = {
    inherit (package) description homepage;
    license = lib.licenses.mit;
    mainProgram = "agent-badge";
    platforms = lib.platforms.unix;
  };

  passthru = { inherit agentBadgeDirectories agentBadgeDirectory; };
}
