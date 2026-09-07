# Dev shell for Linux with all Tauri system deps (webkit, tray, TLS).
# The .deb bundle does not install on NixOS, so develop from this shell:
#   nix develop          # then: npm install, npm run dev:desktop
{
  description = "Second Brain dev shell (Tauri system deps for Linux, incl. NixOS)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      each = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
    in
    {
      devShells = each (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            cargo
            rustc
            pkg-config
            gcc
            openssl
            dbus
            zlib
            sqlite
            webkitgtk_4_1
            gtk3
            libsoup_3
            librsvg
            libayatana-appindicator
            glib-networking
            gsettings-desktop-schemas
            # AT-SPI bus + registry for on-screen text capture
            at-spi2-core
            # gsettings CLI (toolkit-accessibility switch), Wayland client lib
            glib
            wayland
            # Capture helpers (Hyprland/Sway ship their own; these cover X11)
            xorg.xprop
            xprintidle
          ];

          shellHook = ''
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [ pkgs.webkitgtk_4_1 pkgs.gtk3 pkgs.libsoup_3 pkgs.openssl pkgs.dbus ]}:$LD_LIBRARY_PATH"
            export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS"
          '';
        };
      });
    };
}
