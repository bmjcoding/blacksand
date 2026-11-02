# Exact native scan contexts

`lib/native-scan-contexts.json` records nine `@node-datachannel/*@0.33.6`
registry tarballs and their complete `node_datachannel.node` SHA-256 hashes.
`fetchPackage` supplies the name, version and integrity it checked against the
downloaded tarball. Without that identity, or with a different member path or
full-file hash, `scanPackage` applies its original detectors to all bytes.

For an exact match, only the recorded byte offsets are masked in an in-memory
scan copy before the normal host and analytics detectors run. All other bytes
and all other shipped files are still scanned. The package bytes stay intact.
The table is source policy requiring owner review, not package approval, an
age/provenance waiver, or a runtime network guarantee.

The recorded `sentry` occurrences belong to C++ stream-state/cleanup symbols
and debug names, plus OpenSSL's `%*sEntry %0d:` certificate-printing format.
Both Windows files contain only the OpenSSL format occurrence. Android's three
`android.googlesource.com` occurrences are compiler banners in `.comment` and
`.debug_str`; Linux's `gcc.gnu.org` occurrence is a libstdc++ exception message
asking a human to report a compiler bug. That message can occur at runtime.
These contexts do not identify an active telemetry client or HTTP request.

Source ownership:

- [libc++ stream sentries](https://github.com/llvm/llvm-project/blob/llvmorg-21.1.0/libcxx/include/istream)
  and [libstdc++ file-buffer cleanup](https://github.com/gcc-mirror/gcc/blob/releases/gcc-14.2.0/libstdc%2B%2B-v3/include/bits/fstream.tcc).
- [OpenSSL certificate-entry format](https://github.com/openssl/openssl/blob/openssl-3.3.1/crypto/x509/v3_admis.c#L135).
- Android compiler version strings at
  [Clang 22](https://android.googlesource.com/toolchain/llvm-project/+/2d65e4108033380e6fe8e08b1f1826cd2bfb0c99/clang/lib/Basic/Version.cpp)
  and [Clang 21](https://android.googlesource.com/toolchain/llvm-project/+/9f872551d3c681d06fd303b36f16ed5c274735eb/clang/lib/Basic/Version.cpp).
- [GCC insufficient-format-buffer diagnostic](https://github.com/gcc-mirror/gcc/blob/releases/gcc-14.2.0/libstdc%2B%2B-v3/src/c%2B%2B11/snprintf_lite.cc#L32).

The opt-in deep test reads retained npm metadata and tarballs from
`BLACKSAND_T3_NATIVE_SCAN_CACHE`. Each directory is named `name@version` with `/`
replaced by `__`, and contains `packument.json` and `package.tgz`. It uses the
real integrity-checking fetch, scanner and review paths with offline HTTP
responses. No downloaded package code or install script is executed.
