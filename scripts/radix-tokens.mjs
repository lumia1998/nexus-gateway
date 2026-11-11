import * as colors from '@radix-ui/colors'

function hsl(hex) {
    const [r, g, b] = hex.match(/[a-f\d]{2}/gi).slice(0, 3).map(value => parseInt(value, 16) / 255)
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2
    let h = 0
    if (d) h = (max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
    const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0
    return `${h.toFixed(3)} ${(s * 100).toFixed(3)}% ${(l * 100).toFixed(3)}%`
}

export function radixTokens() {
    return [false, true].map(dark => {
        const pick = (scale, step) => colors[scale + (dark ? 'Dark' : '')][scale + step]
        const neutral = step => pick('gray', step)
        const tokens = {
            background: neutral(1), foreground: neutral(12), card: neutral(2), 'card-foreground': neutral(12),
            popover: neutral(2), 'popover-foreground': neutral(12), primary: neutral(12), 'primary-foreground': neutral(1),
            secondary: neutral(3), 'secondary-foreground': neutral(12), muted: neutral(3), 'muted-foreground': neutral(11),
            accent: neutral(4), 'accent-foreground': neutral(12), border: neutral(7), input: neutral(9), ring: neutral(12),
            destructive: pick('red', 3), 'destructive-solid': pick('red', dark ? 4 : 11), 'destructive-text': pick('red', 11),
            'destructive-foreground': dark ? pick('red', 12) : colors.gray.gray1,
            success: pick('grass', 11), warning: pick('amber', 11), info: pick('blue', 11),
            'success-surface': pick('grass', 3), 'warning-surface': pick('amber', 3), 'info-surface': pick('blue', 3)
        }
        return `${dark ? 'html[data-theme="dark"]' : ':root'} {\n${Object.entries(tokens).map(([key, hex]) => `  --${key}: ${hsl(hex)};`).join('\n')}\n  --overlay: ${colors.blackA.blackA9};\n}\n`
    }).join('\n')
}
