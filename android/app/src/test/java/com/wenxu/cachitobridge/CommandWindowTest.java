package com.wenxu.cachitobridge;

import static org.junit.Assert.*;
import org.junit.Test;

public final class CommandWindowTest {
    @Test public void patternUpdatesCannotRenewTheOriginalDeadline() {
        CommandWindow window = new CommandWindow();
        assertEquals(1100, window.accept(100, 1000, true));
        assertEquals(1100, window.accept(500, 1000, false));
        assertEquals(600, window.remaining(500));
        assertEquals(750, window.accept(600, 150, false));
    }

    @Test public void expiredOrStoppedCommandsCannotBeResumedByOldPatternSteps() {
        CommandWindow window = new CommandWindow();
        window.accept(100, 1000, true);
        assertThrows(IllegalArgumentException.class, () -> window.accept(1100, 500, false));
        window.clear();
        assertEquals(0, window.remaining(100));
        assertThrows(IllegalArgumentException.class, () -> window.accept(200, 500, false));
        assertEquals(800, window.accept(300, 500, true));
    }

    @Test public void newCommandsAreStillBoundedByThirtyMinutes() {
        CommandWindow window = new CommandWindow();
        assertThrows(IllegalArgumentException.class, () -> window.accept(0, Long.MAX_VALUE, true));
        assertThrows(IllegalArgumentException.class, () -> window.accept(0, 0, true));
    }
}
