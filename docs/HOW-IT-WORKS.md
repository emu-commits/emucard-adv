# How it works

```
 page (main thread)                         Web Worker
 ┌──────────────────────────────┐   msgs   ┌──────────────────────────────────────────┐
 │ src/main.js     wiring       │ ───────▶ │ src/worker.js   paces the core to wall   │
 │ src/keyboard.js on-screen kb │ ◀─────── │                 time, relays output      │
 │ src/keymap.js   key codes    │  frames, │ vendor/esp32sim.wasm  ESP32-S3 + board   │
 │ src/sdbrowser.js card UI     │  serial, │ src/jit.mjs     compiles hot guest code  │
 │ src/fat.js      FAT driver   │  card    │                 to WebAssembly           │
 │ src/storage.js  IndexedDB    │          └──────────────────────────────────────────┘
 └──────────────────────────────┘
```

## The emulator core

[esp32sim](https://github.com/joakimeriksson/esp32sim) emulates the ESP32-S3's two Xtensa LX7
cores, its peripherals and its mask ROM, so a firmware image boots exactly as on the chip:
ROM, second-stage bootloader, then the app. `vendor/esp32sim-patches/cardputer-adv.patch`
(against esp32sim `6d959ce`) adds the following.

### Cardputer ADV board (`esp32s3/src/board/cardputer_adv.rs`)

Pins come from the libraries AREA512 links, at the revisions it pins (M5GFX `27e1ef0`,
M5Unified `8108bfa`), and from AREA512's own HAL:

| Device | Wiring | Notes |
| --- | --- | --- |
| ST7789V2 1.14" LCD | MOSI 35, SCLK 36, DC 34, CS 37, RST 33 | M5GFX reads its ID (RDDID, 3-wire SPI) to detect the Cardputer, so the panel answers `85 85 52` |
| ADV detection | GPIO 8/9 high, 5/6 low | M5GFX tells the ADV from the v1.1 by the I2C pull-ups on 8/9 |
| TCA8418 keypad | I2C SDA 8, SCL 9, address 0x34 | register file and 10-event FIFO; key codes are `row*10+col+1` |
| microSD | SPI2: SCLK 40, MOSI 14, MISO 39, CS 12 | see below |
| TERM512 panel | SPI2: DC 6, CS 5, RST 3 | TFT builds; sent to the page as the second display |

Every SPI transaction is routed by the chip selects that are low during it, so the LCD, the
card and the TERM512 panel can share SPI hosts the way the firmware shares them.

### SPI3 and receive DMA

Two pieces of the chip were missing from esp32sim and are added in the patch:

- **GP-SPI3.** The Cardputer's LCD is on SPI3 (M5GFX moves it there after detection). esp32sim
  only had SPI2, so the screen could never draw.
- **SPI receive DMA.** ESP-IDF's `spi_master` driver reads MISO data through a GDMA IN channel
  when the bus has DMA enabled, which is how AREA512 sets up the SD bus. esp32sim only wrote
  received bytes to the SPI data registers, so the SD driver never saw the card's replies.

### Why the SD card did not mount before

The earlier attempt (`androidbot18/emucard-adv`, branch `sdcard-crc7-token-scan`) chased
command framing and CRC7, which were correct. The card failed with `ESP_ERR_INVALID_CRC` (0x109)
because the driver received its replies through DMA, which the emulator did not implement. The
replies never reached memory, so the driver read garbage for every response and data block.
With receive DMA in place, a straightforward SD card model is enough
(`esp-soc/src/devices/sd_spi.rs`):

- SDHC, block addressed, CSD version 2.0 sized from the image.
- CMD0/8/55/41/58/59 initialisation with the CRC checking the driver turns on.
- CID, CSD, SCR, SD status and CMD6 switch status.
- Single and multiple block reads and writes with CRC16, and stop transmission.

### Keyboard

The page sends key-down and key-up events (`esp32sim_key`). The board queues them in the
TCA8418's event FIFO and raises its key interrupt flag. AREA512 polls the FIFO over I2C and
does its own shift, Fn, Ctrl, repeat and kana handling, exactly as on the device.

### Busy-wait skip ("spin skip")

AREA512's character input loop calls `vTaskDelay(pdMS_TO_TICKS(2))`. With FreeRTOS at its
default 100 Hz tick that is `vTaskDelay(0)`, a plain yield. On ESP-IDF a yield raises the
core's own `FROM_CPU` software interrupt, so the loop does a full context switch about 120,000
times a second, forever. The chip shrugs this off. Emulating it made the browser 5× slower
than real time.

The fix is in the emulator, not the firmware, so any firmware version works unchanged. The
machine watches each core. If it raises its own yield interrupt 32 times in a row, each within
4,000 instructions of the last, without reading or writing any device register in between, it
can only be polling RAM. The core is parked like `waiti` until its next interrupt (the RTOS
tick, at most 10 ms away), and the withdrawn yield is raised again when it wakes. The firmware
sees nothing it could not see on real hardware: its task was preempted for up to one tick.
Code that does real work touches hardware or yields rarely, so it is never parked.

Results with the firmware unchanged:

| | before | after |
| --- | --- | --- |
| native, 8 emulated seconds | 31 s | 2.9 s |
| WebAssembly in Node, steady state | 5.3 s per emulated second | 0.35 s per emulated second |

The switch is in the ⋮ menu (on by default), and `--spin-skip` on the esp32sim command line.

## The page

- **Firmware** is fetched from `raw.githubusercontent.com/engneer-hamachan/area512/main/firmware/`
  with ETag revalidation and kept in IndexedDB for offline use.
- **The card** is a 64 MB FAT16 image formatted in the browser (`src/fat.js`). The worker reports
  when the firmware writes to it, and the page saves it two seconds after writing stops. Only
  the 1 MiB chunks that changed are rewritten in IndexedDB.
- **Card browser.** Opening it pauses the device and takes a copy of the card. Edits go through
  `src/fat.js` (FAT12/16/32 with long names; output checked with `fsck.vfat` and mtools). If
  anything changed, the new card is inserted and the device restarts. The firmware caches the
  FAT, so changing the card under a running system would corrupt it.
- **Screens.** The worker sends RGB565 frames, tag 1 for the Cardputer LCD and tag 5 for the
  TERM512 panel, and the page draws them with nearest-neighbour scaling.

## Testing

- `npm test`: the FAT driver (format, long names, large files, growing directories, full
  card, MBR) and the keyboard map against the firmware's key table.
- `npm run smoke`: boots `Area512Adv.bin` in Node through the WebAssembly core with a blank
  card. It checks that the card mounts, the board is detected as an ADV, the keypad answers,
  the firmware seeds `Area512_data`, the screen draws, and keys change the screen.
- In esp32sim: `cargo test --release -p esp-soc -p esp32s3` covers the SD card model and the
  keypad.
