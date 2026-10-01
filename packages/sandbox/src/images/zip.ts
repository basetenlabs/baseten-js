// Zip writing and reading, just enough for image source archives.
//
// This package has no runtime dependencies, so that installing it never drags
// in anything else, and a zip library would be its first. No runtime has zip
// built in: CompressionStream compresses one byte stream, which is only the
// inside of each entry. What remains is the container, which is a small, fixed
// part of a format unchanged for decades (PKWARE APPNOTE 6.3): a header before
// each entry, a central directory listing them all at the end, and a CRC-32
// per entry. Only its basic form is used here: deflate or stored entries, UTF-8
// names, Unix permissions, and no ZIP64, encryption, or data descriptors.
//
// Confidence comes from the tests, not from the code looking right: archives
// written here are read back by independent zip implementations (a zip library
// used only in tests, and the system unzip and Python's zipfile where
// available), and archives written by those are read here.

/** One file or directory to put in a zip archive. */
export interface ZipEntry {
  /** Path inside the archive, with forward slashes and no leading slash. */
  path: string;

  /** File content, or undefined for a directory. */
  data?: Uint8Array;

  /** Unix permission bits, such as 0o644. */
  mode: number;
}

// Beyond these, an archive needs ZIP64 extensions, which this writer lacks.
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;

// Version 2.0, the first with deflate and directories, made on Unix so that
// readers apply the permission bits in the external attributes.
const VERSION_NEEDED = 20;
const VERSION_MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;
const FLAG_UTF8_NAME = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const UNIX_FILE_TYPE = 0o100000;
const UNIX_DIRECTORY_TYPE = 0o040000;
const MSDOS_DIRECTORY_ATTRIBUTE = 0x10;

// Every entry gets the earliest DOS timestamp, 1980-01-01 00:00, so the same
// content always makes the same archive.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** Builds a zip archive, compressing each file unless that makes it larger. */
export async function createZip(entries: ZipEntry[]): Promise<Blob> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`a zip archive holds at most ${MAX_ENTRIES} entries, got ${entries.length}`);
  }
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centralHeaders: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const directory = entry.data === undefined;
    const name = encoder.encode(
      directory && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path,
    );
    const data = entry.data ?? new Uint8Array();
    const crc = directory ? 0 : crc32(data);
    let method = METHOD_STORE;
    let stored = data;
    if (!directory && data.length > 0) {
      const deflated = await deflateRaw(data);
      if (deflated.length < data.length) {
        method = METHOD_DEFLATE;
        stored = deflated;
      }
    }

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    local.setUint16(4, VERSION_NEEDED, true);
    local.setUint16(6, FLAG_UTF8_NAME, true);
    local.setUint16(8, method, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, stored.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    central.setUint16(4, VERSION_MADE_BY_UNIX, true);
    central.setUint16(6, VERSION_NEEDED, true);
    central.setUint16(8, FLAG_UTF8_NAME, true);
    central.setUint16(10, method, true);
    central.setUint16(12, DOS_TIME, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, stored.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    const fileType = directory ? UNIX_DIRECTORY_TYPE : UNIX_FILE_TYPE;
    const external =
      (((fileType | (entry.mode & 0o7777)) << 16) >>> 0) |
      (directory ? MSDOS_DIRECTORY_ATTRIBUTE : 0);
    central.setUint32(38, external >>> 0, true);
    central.setUint32(42, offset, true);

    parts.push(new Uint8Array(local.buffer), name, stored);
    centralHeaders.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + stored.length;
    if (offset > MAX_OFFSET) throw new Error("a zip archive can be at most 4GB");
  }

  const centralSize = centralHeaders.reduce((size, part) => size + part.length, 0);
  if (offset + centralSize > MAX_OFFSET) throw new Error("a zip archive can be at most 4GB");
  const end = new DataView(new ArrayBuffer(END_OF_CENTRAL_DIRECTORY_SIZE));
  end.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...centralHeaders, new Uint8Array(end.buffer)] as BlobPart[]);
}

/**
 * Lists the entry paths of a zip archive, reading only its central directory
 * at the end, not the file contents.
 */
export async function zipEntryPaths(zip: Blob): Promise<string[]> {
  const tailStart = Math.max(0, zip.size - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_COMMENT_SIZE);
  const tail = new DataView(await zip.slice(tailStart).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE; i >= 0; i--) {
    if (tail.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive: no end of central directory found");
  const count = tail.getUint16(end + 10, true);
  const centralSize = tail.getUint32(end + 12, true);
  const centralOffset = tail.getUint32(end + 16, true);
  if (count === MAX_ENTRIES || centralOffset === MAX_OFFSET) {
    throw new Error("ZIP64 archives are not supported");
  }
  if (centralOffset + centralSize > zip.size) {
    throw new Error("not a zip archive: central directory is out of bounds");
  }

  const central = new DataView(
    await zip.slice(centralOffset, centralOffset + centralSize).arrayBuffer(),
  );
  const decoder = new TextDecoder();
  const paths: string[] = [];
  let position = 0;
  for (let i = 0; i < count; i++) {
    if (
      position + 46 > central.byteLength ||
      central.getUint32(position, true) !== CENTRAL_HEADER_SIGNATURE
    ) {
      throw new Error("not a zip archive: malformed central directory");
    }
    const nameLength = central.getUint16(position + 28, true);
    const extraLength = central.getUint16(position + 30, true);
    const commentLength = central.getUint16(position + 32, true);
    const nameStart = central.byteOffset + position + 46;
    paths.push(decoder.decode(new Uint8Array(central.buffer, nameStart, nameLength)));
    position += 46 + nameLength + extraLength + commentLength;
  }
  return paths;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let crcTable: Uint32Array | undefined;

/** @internal CRC-32 as zip uses it, the IEEE polynomial. */
export function crc32(data: Uint8Array): number {
  crcTable ??= buildCrcTable();
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
