## Reloading is safe

Ask Claude something long, then reload the window while it is still answering.

The turn keeps running in the daemon. When the tab comes back it replays
everything it missed, including tool calls that completed while you were gone.

The same holds for a dropped network connection, a closed laptop, or a browser
tab you closed by accident.
