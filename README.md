# Cardputer ADV emulator

An M5Stack Cardputer ADV in the browser, running the real
[AREA512](https://github.com/engneer-hamachan/area512) firmware, unmodified, with a working
microSD card. It is a static site (HTML, JavaScript and WebAssembly), so it runs on GitHub
Pages with no server, and works offline after the first visit.

- **Real firmware, as shipped.** The official AREA512 binaries are downloaded from the AREA512
  repository at start-up, so new releases work as soon as they are published. You can also
  load any `.bin` of your own. Nothing is patched.
- **microSD card that works.** The firmware mounts it, sets up `Area512_data` on first boot and
  reads and writes it like a real card. The card is saved in your browser between visits.
- **SD card browser.** Add files or whole folders (button or drag and drop), make folders,
  download or delete files, download the whole card as an `.img` (which you can write to a real
  card), use an existing card image, or format a new card.
- **The Cardputer ADV keyboard.** All 56 keys with the device's legends, multi-touch, plus
  latching modifiers for one-finger use. A physical keyboard works too, translated to the same
  key chords the device would need.
- **TERM512 external display.** The AREA512 TFT builds draw on a 320×240 lid screen above the
  Cardputer, as on a TERM512.

## Using it

Open the page and wait for the boot (the first boot takes 20 to 30 seconds while the firmware
sets up the blank card; later boots are faster). Then:

| | |
| --- | --- |
| Firmware menu | AREA512 for the Cardputer ADV, or the TERM512 builds (ST7789 / ILI9341 panel) |
| **Load .bin** | pick a firmware image from your computer and boot it |
| **Reset** | power cycle; the card stays in |
| **SD card** | pauses the device and opens the card browser. Close it to continue. If you changed anything, the device restarts so the firmware remounts the card |
| ⋮ menu | screenshot, serial console, keyboard help, and the busy-wait skip switch (below) |

AREA512 uses the card's `Area512_data` folder as its own `/`, so `/home` on the device is
`/Area512_data/home` on the card. The card browser opens there and shows both paths.

### Keyboard

The on-screen keys are the device's 4 × 14 layout. Hold a modifier (`fn`, `aa` shift, `ctrl`,
`opt`, `alt`) with one finger while pressing a key with another, or tap it once and it stays
latched (orange outline) for the next key.

On a physical keyboard, type normally. Characters are sent as the Cardputer chord that produces
them (for example `!` is shift + `1`, and `-` is shift + `_`, which is how AREA512 lays out that
key). Arrow keys are `fn` + `;` `.` `,` `/`. Esc is `` ` `` (AREA512 turns it into ESC), and
`` ` `` itself is `fn` + `` ` ``. Ctrl+Space toggles AREA512's kana input.

## Supported firmware

| Binary | Status |
| --- | --- |
| `Area512Adv.bin` | Cardputer ADV: works |
| `Area512TFT7789.bin`, `Area512TFT9341.bin` | Cardputer ADV + TERM512: both screens work |
| `Area512V11.bin` | Cardputer v1.1: boots, but its GPIO-matrix keyboard is not emulated (the ADV's TCA8418 is) |

Other ESP32-S3 firmware for the Cardputer ADV that uses the same hardware (M5Unified / M5GFX
display, TCA8418 keyboard, SPI microSD) should also run. Audio, the IMU, Wi-Fi and IR are not
emulated.

## Running locally

```sh
python3 -m http.server 8080     # any static server; ES modules need http://, not file://
# open http://localhost:8080
npm test                        # unit tests (FAT driver, keyboard map)
npm run smoke                   # boots AREA512 headlessly: SD mount, screen, keyboard
```

## Deploying

`.github/workflows/pages.yml` runs the tests, then publishes the site on every push to `main`.
In the repository settings, set **Pages → Source** to **GitHub Actions** once.

## How it works

The CPU, peripherals and boot ROM come from
[esp32sim](https://github.com/joakimeriksson/esp32sim), an instruction-accurate ESP32-S3
emulator in Rust compiled to WebAssembly. `vendor/esp32sim-patches/cardputer-adv.patch` adds
the Cardputer ADV hardware to it. It runs in a Web Worker so the page stays responsive.
See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for details, including why the SD card did
not work before.

To rebuild the WebAssembly core: `tools/build-wasm.sh` (needs git and a Rust toolchain via
rustup). It clones esp32sim at the pinned revision, applies the patch, and writes
`vendor/esp32sim.wasm`.

### The busy-wait skip

AREA512's input loop waits with `vTaskDelay(pdMS_TO_TICKS(2))`, which is zero ticks at the
default 100 Hz FreeRTOS tick, so the loop never sleeps. It just keeps yielding to itself. On the
chip that only wastes power, but emulating it made the browser run five times slower than real
time. The emulator now notices a core that keeps yielding to itself without touching any
hardware, and lets it sit idle until its next interrupt (at most one 10 ms tick). To the
firmware this is the same as being preempted for a moment, so behaviour is unchanged and no
firmware is modified. Untick **Skip busy-wait loops** in the ⋮ menu to emulate every iteration.

## Licences and credits

- This emulator: MIT (see `LICENSE`).
- esp32sim: MIT, Joakim Eriksson and contributors. `vendor/esp32sim.wasm` and `src/jit.mjs` are
  built from it.
- ESP32-S3 mask ROM (`vendor/esp32s3_rev0_rom.elf`): Apache-2.0, Espressif Systems, from
  [esp-rom-elfs](https://github.com/espressif/esp-rom-elfs).
- AREA512: MIT, engneer-hamachan. The firmware is downloaded from its repository and is not
  included here.
- TERM512 external display and case by Prokuon.
