package encoded

import "encoding/hex"

// H264ConstrainedBaselineLevel recognizes the equivalent coding-tool subsets
// in RFC 6184 Table 5. Callers own their permitted level range.
func H264ConstrainedBaselineLevel(value string) (byte, bool) {
	if len(value) != 6 {
		return 0, false
	}
	profile, err := hex.DecodeString(value)
	if err != nil {
		return 0, false
	}
	constrainedBaseline := (profile[0] == 0x42 && profile[1]&0x4f == 0x40) ||
		(profile[0] == 0x4d && profile[1]&0x8f == 0x80) ||
		(profile[0] == 0x58 && profile[1]&0xcf == 0xc0)
	return profile[2], constrainedBaseline
}
