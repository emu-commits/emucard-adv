// The microSD browser: shows the card image as folders and files, and adds, downloads and
// deletes files with the FAT driver in fat.js. It works on a copy of the card; `open()`
// resolves with {image, changed} when the window closes.
import { FatVolume, FatError, formatImage } from './fat.js';

const $ = (id) => document.getElementById(id);

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function createSdBrowser() {
  const dialog = $('sd-dialog');
  let image = null;
  let vol = null;
  let cwd = '/';
  let opened = false;
  let changed = false;
  // AREA512 shows the card's /Area512_data folder as its own "/".
  const DEVICE_ROOT = '/Area512_data';
  let resolveClose = null;

  const join = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;

  function mount(img) {
    image = img;
    try {
      vol = new FatVolume(image);
    } catch (err) {
      vol = null;
      $('sd-entries').innerHTML = '';
      $('sd-usage').textContent = 'Unreadable card: ' + err.message;
      return;
    }
    if (!opened && vol.lookup(DEVICE_ROOT + '/home')) cwd = DEVICE_ROOT + '/home';
    opened = true;
    if (!vol.lookup(cwd)) cwd = '/';
    render();
  }

  function render() {
    if (!vol) return;
    const inDevice = cwd === DEVICE_ROOT || cwd.startsWith(DEVICE_ROOT + '/');
    $('sd-cwd').textContent = cwd + (inDevice ? `   (on the device: ${cwd.slice(DEVICE_ROOT.length) || '/'})` : '');
    $('sd-up').disabled = cwd === '/';
    const used = vol.totalBytes - vol.freeBytes;
    $('sd-usage').textContent = `FAT${vol.type} · ${fmtSize(used)} used of ${fmtSize(vol.totalBytes)}`;
    const rows = vol.list(cwd).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    const tbody = $('sd-entries');
    tbody.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="name" style="color:var(--muted)">(empty folder)</td>';
      tbody.append(tr);
    }
    for (const e of rows) {
      const tr = document.createElement('tr');
      tr.className = e.isDir ? 'dir' : 'file';
      const name = document.createElement('td');
      name.className = 'name';
      name.textContent = (e.isDir ? '\u{1F4C1} ' : '') + e.name;
      if (e.isDir) name.addEventListener('click', () => { cwd = join(cwd, e.name); render(); });
      const size = document.createElement('td');
      size.className = 'size';
      size.textContent = e.isDir ? '' : fmtSize(e.size);
      const act = document.createElement('td');
      if (!e.isDir) {
        const dl = document.createElement('button');
        dl.textContent = 'Download';
        dl.addEventListener('click', () => download(e.name, vol.readFile(join(cwd, e.name))));
        act.append(dl, ' ');
      }
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.className = 'danger';
      del.addEventListener('click', () => {
        if (!confirm(`Delete ${e.isDir ? 'the folder' : ''} "${e.name}"${e.isDir ? ' and everything in it' : ''}?`)) return;
        guard(() => { vol.remove(join(cwd, e.name)); changed = true; });
      });
      act.append(del);
      tr.append(name, size, act);
      tbody.append(tr);
    }
  }

  function guard(fn) {
    try { fn(); } catch (err) { alert(err instanceof FatError ? err.message : String(err)); }
    render();
  }

  /** Copy [{path, file}] onto the card under the current folder. */
  async function addFiles(items) {
    let n = 0;
    for (const { path, file } of items) {
      const data = new Uint8Array(await file.arrayBuffer());
      try {
        vol.writeFile(join(cwd, path), data);
        n++;
        changed = true;
      } catch (err) {
        alert(`Could not copy ${path}: ${err.message}`);
        break;
      }
    }
    render();
    return n;
  }

  async function entriesFromDrop(dt) {
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ path: prefix + entry.name, file });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child, prefix + entry.name + '/');
        }
      }
    };
    const entries = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) { for (const e of entries) await walk(e, ''); }
    else for (const f of dt.files) out.push({ path: f.name, file: f });
    return out;
  }

  $('sd-up').addEventListener('click', () => { cwd = cwd.replace(/\/[^/]*$/, '') || '/'; render(); });
  $('sd-add').addEventListener('click', () => $('sd-files').click());
  $('sd-add-dir').addEventListener('click', () => $('sd-folder').click());
  $('sd-files').addEventListener('change', async (ev) => {
    await addFiles([...ev.target.files].map((f) => ({ path: f.name, file: f })));
    ev.target.value = '';
  });
  $('sd-folder').addEventListener('change', async (ev) => {
    await addFiles([...ev.target.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f })));
    ev.target.value = '';
  });
  $('sd-mkdir').addEventListener('click', () => {
    const name = prompt('New folder name');
    if (name) guard(() => { vol.mkdir(join(cwd, name)); changed = true; });
  });
  $('sd-export').addEventListener('click', () => download('cardputer-sd.img', image));
  $('sd-import').addEventListener('click', () => $('sd-image').click());
  $('sd-image').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    const data = new Uint8Array(await f.arrayBuffer());
    if (data.length % 512) { alert('That is not a card image: its size is not a whole number of 512-byte sectors.'); return; }
    // The card model describes its size in 512 KiB units; pad up rather than reject.
    const size = Math.ceil(data.length / 524288) * 524288;
    const img = new Uint8Array(size);
    img.set(data);
    try { new FatVolume(img); } catch (err) { if (!confirm(`This image has no FAT file system the browser can read (${err.message}). Use it anyway?`)) return; }
    changed = true;
    cwd = '/';
    mount(img);
  });
  $('sd-format').addEventListener('click', () => {
    const answer = prompt('Erase the card and format it. Card size in MB (16 to 2048):', String(Math.round(image.length / 1048576)));
    if (!answer) return;
    const mb = Math.max(16, Math.min(2048, Math.round(Number(answer)) || 0));
    if (!confirm(`Format a ${mb} MB card? Everything on the current card is lost.`)) return;
    changed = true;
    cwd = '/';
    mount(formatImage(mb * 1048576));
  });

  const drop = $('sd-drop');
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    drop.classList.remove('drag');
    if (vol) await addFiles(await entriesFromDrop(ev.dataTransfer));
  });

  dialog.addEventListener('close', () => {
    if (resolveClose) { resolveClose({ image, changed }); resolveClose = null; }
  });

  return {
    /** Show the card; resolves with the (possibly changed) image when closed. */
    open(img) {
      changed = false;
      mount(img);
      dialog.showModal();
      return new Promise((resolve) => { resolveClose = resolve; });
    },
  };
}
