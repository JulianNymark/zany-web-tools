/**
 * mvt.js — tiny, dependency-free Mapbox Vector Tile (MVT) reader.
 *
 * Only what this page needs: layers -> features -> polygon rings in tile
 * coordinates (0..extent, y grows downward), plus a tag lookup.
 *
 * Plain <script> (no ES module) so the page also works from file://.
 * Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 */
(function (global) {
  'use strict';

  /** Read a base-128 varint at `pos`; returns [value, nextPos]. */
  function readVarint(buf, pos) {
    let result = 0;
    let mul = 1;
    let b;
    do {
      b = buf[pos++];
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return [result, pos];
  }

  /** Advance past a field we do not care about. */
  function skipField(buf, pos, wire) {
    switch (wire) {
      case 0: // varint
        return readVarint(buf, pos)[1];
      case 1: // 64-bit
        return pos + 8;
      case 2: {
        // length-delimited
        const [len, p] = readVarint(buf, pos);
        return p + len;
      }
      case 5: // 32-bit
        return pos + 4;
      default:
        throw new Error('MVT: unsupported wire type ' + wire);
    }
  }

  const GEOM_MOVE_TO = 1;
  const GEOM_LINE_TO = 2;
  const GEOM_CLOSE_PATH = 7;

  /** Decode the packed command/parameter stream of a feature geometry. */
  function readGeometry(geom) {
    const rings = [];
    let ring = null;
    let x = 0;
    let y = 0;
    let i = 0;

    while (i < geom.length) {
      const cmd = geom[i++];
      const id = cmd & 0x7;
      const count = cmd >> 3;

      if (id === GEOM_MOVE_TO) {
        for (let n = 0; n < count; n++) {
          x += (geom[i] >>> 1) ^ -(geom[i] & 1);
          i++;
          y += (geom[i] >>> 1) ^ -(geom[i] & 1);
          i++;
          ring = [[x, y]];
          rings.push(ring);
        }
      } else if (id === GEOM_LINE_TO) {
        for (let n = 0; n < count; n++) {
          x += (geom[i] >>> 1) ^ -(geom[i] & 1);
          i++;
          y += (geom[i] >>> 1) ^ -(geom[i] & 1);
          i++;
          if (ring) ring.push([x, y]);
        }
      } else if (id === GEOM_CLOSE_PATH) {
        if (ring && ring.length) ring.push([ring[0][0], ring[0][1]]);
      } else {
        throw new Error('MVT: unknown geometry command ' + id);
      }
    }
    return rings;
  }

  function readValue(buf) {
    let pos = 0;
    let value = null;
    while (pos < buf.length) {
      let tag;
      [tag, pos] = readVarint(buf, pos);
      const field = tag >>> 3;
      const wire = tag & 0x7;
      if (field === 1 && wire === 2) {
        const [len, p] = readVarint(buf, pos);
        value = utf8(buf.subarray(p, p + len));
        pos = p + len;
      } else if (field === 2 && wire === 5) {
        value = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true);
        pos += 4;
      } else if (field === 3 && wire === 1) {
        value = new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true);
        pos += 8;
      } else if ((field === 4 || field === 5 || field === 6) && wire === 0) {
        let raw;
        [raw, pos] = readVarint(buf, pos);
        value = field === 6 ? (raw >>> 1) ^ -(raw & 1) : raw;
      } else if (field === 7 && wire === 0) {
        let raw;
        [raw, pos] = readVarint(buf, pos);
        value = raw !== 0;
      } else {
        pos = skipField(buf, pos, wire);
      }
    }
    return value;
  }

  function readFeature(buf, keys, values) {
    let pos = 0;
    let id = null;
    let type = 0;
    const tags = [];
    const geometry = [];

    while (pos < buf.length) {
      let tag;
      [tag, pos] = readVarint(buf, pos);
      const field = tag >>> 3;
      const wire = tag & 0x7;

      if (field === 1 && wire === 0) {
        [id, pos] = readVarint(buf, pos);
      } else if (field === 2 && wire === 2) {
        const [len, p] = readVarint(buf, pos);
        const end = p + len;
        let q = p;
        while (q < end) {
          let v;
          [v, q] = readVarint(buf, q);
          tags.push(v);
        }
        pos = end;
      } else if (field === 2 && wire === 0) {
        let v;
        [v, pos] = readVarint(buf, pos);
        tags.push(v);
      } else if (field === 3 && wire === 0) {
        [type, pos] = readVarint(buf, pos);
      } else if (field === 4 && wire === 2) {
        const [len, p] = readVarint(buf, pos);
        const end = p + len;
        let q = p;
        while (q < end) {
          let v;
          [v, q] = readVarint(buf, q);
          geometry.push(v);
        }
        pos = end;
      } else if (field === 4 && wire === 0) {
        let v;
        [v, pos] = readVarint(buf, pos);
        geometry.push(v);
      } else {
        pos = skipField(buf, pos, wire);
      }
    }

    const properties = {};
    for (let i = 0; i + 1 < tags.length; i += 2) {
      properties[keys[tags[i]]] = values[tags[i + 1]];
    }

    return { id, type, properties, rings: readGeometry(geometry) };
  }

  function readLayer(buf) {
    let pos = 0;
    let name = '';
    let extent = 4096;
    let version = 1;
    const keys = [];
    const values = [];
    const features = [];

    while (pos < buf.length) {
      let tag;
      [tag, pos] = readVarint(buf, pos);
      const field = tag >>> 3;
      const wire = tag & 0x7;

      if (field === 1 && wire === 2) {
        const [len, p] = readVarint(buf, pos);
        name = utf8(buf.subarray(p, p + len));
        pos = p + len;
      } else if (field === 2 && wire === 2) {
        const [len, p] = readVarint(buf, pos);
        features.push(buf.subarray(p, p + len));
        pos = p + len;
      } else if (field === 3 && wire === 2) {
        const [len, p] = readVarint(buf, pos);
        keys.push(utf8(buf.subarray(p, p + len)));
        pos = p + len;
      } else if (field === 4 && wire === 2) {
        const [len, p] = readVarint(buf, pos);
        values.push(readValue(buf.subarray(p, p + len)));
        pos = p + len;
      } else if (field === 5 && wire === 0) {
        [extent, pos] = readVarint(buf, pos);
      } else if (field === 15 && wire === 0) {
        [version, pos] = readVarint(buf, pos);
      } else {
        pos = skipField(buf, pos, wire);
      }
    }

    return {
      name,
      extent,
      version,
      features: features.map((buf) => readFeature(buf, keys, values)),
    };
  }

  /**
   * Decode a whole tile.
   * @param {ArrayBuffer|Uint8Array} data raw .pbf bytes
   * @returns {Map<string, {name:string, extent:number, features:Array}>}
   */
  function readTile(data) {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    const layers = new Map();
    let pos = 0;

    while (pos < buf.length) {
      let tag;
      [tag, pos] = readVarint(buf, pos);
      const field = tag >>> 3;
      const wire = tag & 0x7;

      if (field === 3 && wire === 2) {
        const [len, p] = readVarint(buf, pos);
        const layer = readLayer(buf.subarray(p, p + len));
        layers.set(layer.name, layer);
        pos = p + len;
      } else {
        pos = skipField(buf, pos, wire);
      }
    }
    return layers;
  }

  function utf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  global.MVT = { readTile };
})(typeof globalThis !== 'undefined' ? globalThis : this);