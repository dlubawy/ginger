{ pkgs, version, ... }:
pkgs.writeTextFile {
  name = "build-config";
  text = ''
    {
      "arch": "aarch64",
      "distro": "alpine",
      "env": {
        "NIX_SSL_CERT_FILE": "/etc/nix/cert.pem",
        "PI_SKIP_VERSION_CHECK": "1",
        "PI_CODING_AGENT_DIR": "/etc/pi/agent"
      },
      "rootfs": {
        "label": "gondolin-root",
        "sizeMb": 5000
      },
      "oci": {
        "image": "localhost/gondolin-image:v${version}"
      },
      "init": {
        "rootfsInitExtra": "gondolin-init-extra.sh"
      },
      "postBuild": {
        "copy": [
          {"src": "./rootfs/etc/dbus-1", "dest": "/etc/dbus-1"},
          {"src": "./rootfs/share/dbus-1", "dest": "/share/dbus-1"},
          {"src": "./rootfs/share/xml/dbus-1", "dest": "/share/xml/dbus-1"}
        ]
      }
    }
  '';
  destination = "/build-config.json";
}
