# Phone Control — Windows host packaging helpers
#
# Cross-compile + zip-ready folder (no MSI). Default target: x86_64-pc-windows-gnu.
#
#   make build-windows
#   make package-windows
#   make test-linux          # ensure host Linux build still green

.PHONY: build-windows package-windows test-linux clean-windows-dist

ROOT := $(abspath .)
TARGET ?= x86_64-pc-windows-gnu
DIST ?= dist/windows

build-windows:
	PHONECONTROL_WINDOWS_TARGET=$(TARGET) bash scripts/build-windows.sh

package-windows:
	PHONECONTROL_WINDOWS_TARGET=$(TARGET) PHONECONTROL_WINDOWS_DIST=$(DIST) bash scripts/package-windows.sh

test-linux:
	cargo test --workspace
	cargo build -p phonecontrol-agent --release

clean-windows-dist:
	rm -f $(DIST)/PhoneControl.exe
