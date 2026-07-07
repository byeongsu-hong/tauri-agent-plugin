/// Returns `bytes` cryptographically-random bytes rendered as lowercase hex.
///
/// `getrandom::fill` only fails when the OS RNG is unavailable, which does not
/// happen on supported desktop platforms; in that theoretical case we fall back
/// to a process/address-seeded value so callers never panic. Do not rely on the
/// fallback for security guarantees.
pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0_u8; bytes];
    if getrandom::fill(&mut buf).is_err() {
        let seed = std::process::id().to_le_bytes();
        let addr = &buf as *const _ as usize;
        for (index, byte) in buf.iter_mut().enumerate() {
            *byte = seed[index % seed.len()] ^ (addr as u8).wrapping_add(index as u8);
        }
    }
    buf.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_hex_has_expected_length_and_is_hex() {
        let value = random_hex(16);
        assert_eq!(value.len(), 32);
        assert!(value.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn random_hex_values_differ() {
        assert_ne!(random_hex(16), random_hex(16));
    }
}
