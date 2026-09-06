/**
 * MaskedInput behavioral tests (ported from the reverted pi-tui
 * `tests/input-masked.spec.ts`): display shows bullets only, the value stays
 * raw, and plain `Input` is never masked.
 * @module @dsh-cc/tui/input-masked
 */
import { describe, expect, it } from 'vitest'
import { Input } from '@dsh-cc/pi-tui'
import { MaskedInput } from '@dsh-cc/tui/components/masked-input.ts'

/** Strip ANSI escape sequences so assertions see plain display text. */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI needs control chars
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

function renderedText(input: { render(width: number): string[] }, width = 40): string {
  return stripAnsi(input.render(width).join('\n'))
}

describe('MaskedInput', () => {
  it('renders bullets only, never a substring of the raw value', () => {
    const input = new MaskedInput()
    input.handleInput('s3cr3t')
    const text = renderedText(input)
    expect(input.getValue()).toBe('s3cr3t')
    expect(text).toContain('••••••')
    expect(text).not.toContain('s3cr3t')
    for (const ch of 's3cr3t') {
      expect(text).not.toContain(ch)
    }
  })

  it('emits the raw value on submit', () => {
    const input = new MaskedInput()
    let submitted = ''
    input.onSubmit = (v) => {
      submitted = v
    }
    input.handleInput('hunter2')
    input.handleInput('\r')
    expect(submitted).toBe('hunter2')
  })

  it('keeps raw buffer consistent with bullet count when typing', () => {
    const input = new MaskedInput()
    input.handleInput('ab')
    expect(renderedText(input).match(/•/g)?.length).toBe(2)
    input.handleInput('c')
    expect(input.getValue()).toBe('abc')
    expect(renderedText(input).match(/•/g)?.length).toBe(3)
  })

  it('handles multi-character paste under masking', () => {
    const input = new MaskedInput()
    input.handleInput('\x1b[200~p4ssw0rd!\x1b[201~')
    const text = renderedText(input)
    expect(input.getValue()).toBe('p4ssw0rd!')
    expect(text.match(/•/g)?.length).toBe(9)
    expect(text).not.toContain('p4ss')
  })

  it('backspace removes one bullet and one raw character', () => {
    const input = new MaskedInput()
    input.handleInput('abcd')
    input.handleInput('\x7f') // backspace
    expect(input.getValue()).toBe('abc')
    expect(renderedText(input).match(/•/g)?.length).toBe(3)
  })

  it('forward delete keeps raw buffer consistent', () => {
    const input = new MaskedInput()
    input.handleInput('abcd')
    input.handleInput('\x1b[D') // left
    input.handleInput('\x1b[D') // left
    input.handleInput('\x1b[3~') // delete key
    expect(input.getValue()).toBe('abd')
    expect(renderedText(input).match(/•/g)?.length).toBe(3)
  })

  it('cursor movement and mid-string insert work under masking', () => {
    const input = new MaskedInput()
    input.handleInput('ab')
    input.handleInput('\x1b[D') // left
    input.handleInput('X')
    expect(input.getValue()).toBe('aXb')
    expect(renderedText(input).match(/•/g)?.length).toBe(3)
    expect(input.getValue()).not.toBe(renderedText(input).trim())
  })

  it('empty state renders the same as unmasked (placeholder/empty)', () => {
    const masked = new MaskedInput()
    const plain = new Input()
    expect(renderedText(masked)).toBe(renderedText(plain))
    expect(renderedText(masked)).not.toContain('•')
  })

  it('without MaskedInput, plain Input never masks', () => {
    const input = new Input()
    input.handleInput('abc')
    expect(renderedText(input)).toContain('abc')
    expect(renderedText(input)).not.toContain('•')
    expect(input.getValue()).toBe('abc')
  })
})
