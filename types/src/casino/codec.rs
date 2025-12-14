use bytes::{Buf, BufMut};
use commonware_codec::{Error, ReadExt, Write};

/// Helper to write a string as length-prefixed UTF-8 bytes.
pub fn write_string(s: &str, writer: &mut impl BufMut) {
    let bytes = s.as_bytes();
    (bytes.len() as u32).write(writer);
    writer.put_slice(bytes);
}

/// Helper to read a string from length-prefixed UTF-8 bytes.
pub fn read_string(reader: &mut impl Buf, max_len: usize) -> Result<String, Error> {
    let len = u32::read(reader)? as usize;
    if len > max_len {
        return Err(Error::Invalid("String", "too long"));
    }
    if reader.remaining() < len {
        return Err(Error::EndOfBuffer);
    }
    let mut bytes = vec![0u8; len];
    reader.copy_to_slice(&mut bytes);
    String::from_utf8(bytes).map_err(|_| Error::Invalid("String", "invalid UTF-8"))
}

/// Helper to get encode size of a string.
pub fn string_encode_size(s: &str) -> usize {
    4 + s.len()
}
