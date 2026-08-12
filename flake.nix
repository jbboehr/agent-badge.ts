{
  description = "Local-first CLI for publishing AI usage badges";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
    gitignore = {
      url = "github:hercules-ci/gitignore.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      gitignore,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        src = gitignore.lib.gitignoreSource ./.;
        agent-badge-unwrapped = pkgs.callPackage ./nix/agent-badge-unwrapped.nix {
          inherit src;
        };
        agent-badge = pkgs.callPackage ./nix/agent-badge.nix {
          inherit agent-badge-unwrapped;
        };
        defaultPackage = if pkgs.stdenv.hostPlatform.isLinux then agent-badge else agent-badge-unwrapped;
      in
      {
        checks = {
          inherit agent-badge-unwrapped;
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          inherit agent-badge;
        };

        packages = {
          default = defaultPackage;
          inherit agent-badge-unwrapped;
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          inherit agent-badge;
        };

        apps.default = {
          type = "app";
          program = pkgs.lib.getExe defaultPackage;
          meta.description = "Run the agent-badge CLI";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            defaultPackage
            pkgs.gh
            pkgs.gitMinimal
            pkgs.nodejs_24
          ];
        };
      }
    );
}
