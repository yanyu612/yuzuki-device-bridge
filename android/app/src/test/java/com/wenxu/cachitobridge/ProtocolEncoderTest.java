package com.wenxu.cachitobridge;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class ProtocolEncoderTest {
    @Test
    public void encodesSyntheticPowerFrameUsingVerifiedLayout() {
        ProtocolEncoder.EncodedCommand command = ProtocolEncoder.power(74, 0x6B, "BEEF");
        assertEquals("71000C6B8200BEEF01006400005702D5", command.packetHex);
        assertEquals("71000c6b-8200-beef-0100-6400005702d5", command.serviceUuid.toString());
    }

    @Test
    public void encodesSyntheticStopFrameUsingVerifiedLayout() {
        ProtocolEncoder.EncodedCommand command = ProtocolEncoder.stop(0x66, "BEEF");
        assertEquals("71000C660F00BEEF01000000000000A0", command.packetHex);
        assertEquals("71000c66-0f00-beef-0100-0000000000a0", command.serviceUuid.toString());
    }

    @Test
    public void checksumMatchesKnownSample() {
        assertEquals("D5", ProtocolEncoder.checksum("71000C6B8200BEEF01006400005702"));
    }
}
