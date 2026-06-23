# Incline support
The only extra feature I may add to walkpadspeed is controlling the incline for walking pads that support it, if there is ever a real demand. This document specifies how such a feature would be implemented.

## File format
- incline would be an optional number with a % added. E.g for a 300 seconds step at 4.0 km/h speed and 5% degrees (or grad percentage), the step lines could be:
```
4.0 300 5% Fast Walk Step
4.0 5% 300 Fast Walk Step
```
- if incline is not present, the previous value is kept (no order is issued)

## UI
- a simple narrow number (2 digits max) in a .metric-box at the right of #liveSpeed
- maybe in orange or blue if non-zero
- this metric-box should be only added to the UI (dynamically by JS) if any step of the routine has an incline

## Implementation

### Parser

To allow flexible positioning, optional inclines (defaulting to 0% if omitted), and your preferred `//` comment syntax, you can use a regular expression approach in JavaScript.

Instead of splitting strictly by spaces (which breaks down if positions swap or text names are handled carelessly), you can use a regex that explicitly extracts the data types:

```javascript
function parseRoutineLine(line, routineNameCached, index, totalSteps) {
    // 1. Strip comments out first
    // Removes everything after // (handling optional leading space cleanly)
    const cleanLine = line.split(/\s*\/\/+/)[0].trim();
    if (!cleanLine) return null; // Empty or comment-only line

    // 2. Extract explicit types using regex matches
    const inclineMatch = cleanLine.match(/(\d+)%/);       // Looks for an integer followed by %
    const speedMatch = cleanLine.match(/(\d+\.\d+)/);     // Looks for a decimal number (X.Y)
    
    // Duration is trickier: it's an integer NOT followed by %
    // We can find all integers and pick the one that doesn't map to the incline
    const integers = cleanLine.match(/\b\d+\b/g) || [];
    
    if (!speedMatch) return null; // Speed is mandatory

    const speed = parseFloat(speedMatch[1]);
    const incline = inclineMatch ? parseInt(inclineMatch[1], 10) : 0; // Default to 0% if missing
    
    // Find the integer token that represents duration
    const inclineRawValue = inclineMatch ? inclineMatch[1] : null;
    const durationToken = integers.find(num => num !== inclineRawValue);
    if (!durationToken) return null; // Duration is mandatory
    const duration = parseInt(durationToken, 10);

    // 3. Extract the Step Name
    // Strip the matched speed, duration, and incline tokens out of the clean line.
    // Whatever text remains is your custom step name!
    let stepName = cleanLine
        .replace(speedMatch[0], '')
        .replace(durationToken, '')
        .replace(inclineMatch ? inclineMatch[0] : '', '')
        .replace(/\s+/g, ' ') // Collapse extra spaces
        .trim();

    // Fallback if no custom text name was provided
    if (!stepName) {
        stepName = `${routineNameCached} [${index + 1}/${totalSteps}]`;
    }

    return {
        speed: speed,
        duration: duration,
        incline: incline,
        name: stepName
    };
}

```

#### Why this design shines:

1. **Zero column-order bugs:** A user can type `4.0 300 5%` or `4.0 5% 300` or even `5% 300 4.0`. The regex doesn't care about the order; it extracts the variables based on their format identity.
2. **Backwards Compatible:** If you process an older routine file that only contains `4.0 300 Power Walk`, the `inclineMatch` returns `null` and safely defaults the incline to `0` without throwing a single error.
3. **Natural Text Separation:** Because the text labels don't match decimal formats or the `%` symbol, stripping the tokens out leaves exactly the step name string intact—meaning users can just write naturally without complex quote enclosures.

### Bluetooth FMTS

In the Bluetooth **Fitness Machine Service (FTMS)** protocol, incline is always transmitted as an **absolute target value**, not as a relative difference or an amount to move.

When you send an incline control command to the treadmill, you are telling the machine exactly what grade percentage it should change to, and the machine's internal hardware handles the rest.

#### How the Command is Structured

In the **Fitness Machine Control Point** characteristic (which is what you write bytes to), the instruction breaks down like this:

1. **Op Code (`0x03`):** The standard FTMS operation code for "Set Inclination".
2. **The Value:** A 16-bit signed integer (2 bytes) representing the absolute target inclination, transmitted in **Little Endian** format.

#### The Scale Factor

Because Bluetooth parameters are sent as integers to save bandwidth, FTMS uses a defined **resolution of 0.1%** for incline. To send an absolute incline, you must multiply your target percentage by 10 before converting it to bytes.

* **To set incline to 0%:** You send `0` (`0x00, 0x00`)
* **To set incline to 5%:** $5 \times 10 = 50$, so you send `50` (`0x32, 0x00`)
* **To set incline to 12%:** $12 \times 10 = 120$, so you send `120` (`0x78, 0x00`)

#### Example JavaScript Byte Array

If you were writing the command to set the walkpad to an absolute incline of **5%**, your raw byte array would look like this:

```javascript
// Opcode 0x03 (Set Incline), followed by 50 (0x32, 0x00) in 16-bit Little Endian
const buffer = new Uint8Array([0x03, 0x32, 0x00]);
await ftmsControlCharacteristic.writeValue(buffer);

```

Because it is an absolute target, you don't need to track where the incline currently is to calculate a delta. The machine will receive `0x03, 0x32, 0x00`, realize it needs to be at 5%, and engage its internal motor to move up or down until it reaches that absolute position.
