# ADBoard — packaging + dependency helpers
#
# Cross-compile + zip-ready folder (no MSI). Default target: x86_64-pc-windows-gnu.
#
#   make fetch-deps          # ADB + scrcpy → ./temp/ → tools/ + dist/windows/vendor/
#   make fetch-deps FETCH_TARGET=windows
#   make fetch-deps FETCH_TARGET=all FETCH_FORCE=1
#   make build-windows
#   make package-windows
#   make test-linux          # ensure host Linux build still green

.PHONY: fetch-deps build-windows package-windows test-linux clean-windows-dist clean-temp

ROOT := $(abspath .)
TARGET ?= x86_64-pc-windows-gnu
DIST ?= dist/windows
FETCH_TARGET ?=
FETCH_FORCE ?= 0

fetch-deps:
	FETCH_TARGET="$(FETCH_TARGET)" FETCH_FORCE="$(FETCH_FORCE)" bash scripts/fetch-deps.sh

build-windows:
	PHONECONTROL_WINDOWS_TARGET=$(TARGET) bash scripts/build-windows.sh

package-windows:
	PHONECONTROL_WINDOWS_TARGET=$(TARGET) PHONECONTROL_WINDOWS_DIST=$(DIST) bash scripts/package-windows.sh

test-linux:
	cargo test --workspace
	cargo build -p phonecontrol-agent --release

clean-windows-dist:
	rm -f $(DIST)/ADBoard.exe $(DIST)/PhoneControl.exe

clean-temp:
	rm -rf $(ROOT)/temp
