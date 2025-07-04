{
  description = "Tubely Dev Shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            ffmpeg
            sqlite
            awscli2
            nodejs_20
            gcc
            libgcc
            typescript
          ];

          shellHook = ''
            echo "Tubely dev environment ready!"
            echo "Run the server with: bun run src/index.ts"
            LD_LIBRARY_PATH=${pkgs.stdenv.cc.cc.lib}/lib
          '';
        };
      });
}

