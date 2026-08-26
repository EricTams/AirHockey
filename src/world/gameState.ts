import type { Condition } from './event'

/**
 * Flags and variables: the memory an event system needs to mean anything.
 *
 * Flags are named booleans, variables named numbers, both defaulting to
 * false/0 so a condition on a name nobody has set yet is answerable rather than
 * an error. That default is what lets a designer write the "after you have beaten
 * Blorb" page before writing the page that sets the flag.
 *
 * Deliberately not persisted. Doc §1 puts save/load out of v1 scope, and a
 * localStorage autosave would be a save system by the back door — no slots, no
 * versioning, and no way to tell a designer's test state from a player's game.
 * The editor gets a panel to read and set these instead, which is what makes
 * events testable without walking the world again after every reload.
 */
export class GameState {
  private flags = new Map<string, boolean>()
  private vars = new Map<string, number>()
  private version = 0

  /** Bumped on every change, so watchers can tell whether to re-read. */
  get revision(): number { return this.version }

  flag(name: string): boolean { return this.flags.get(name) ?? false }
  variable(name: string): number { return this.vars.get(name) ?? 0 }

  setFlag(name: string, value: boolean): void {
    if (this.flag(name) === value) return
    this.flags.set(name, value)
    this.version++
  }

  setVariable(name: string, value: number): void {
    if (this.variable(name) === value) return
    this.vars.set(name, value)
    this.version++
  }

  addVariable(name: string, by: number): void {
    this.setVariable(name, this.variable(name) + by)
  }

  test(condition: Condition): boolean {
    if ('flag' in condition) return this.flag(condition.flag) === condition.is
    const left = this.variable(condition.var)
    const right = condition.value
    switch (condition.op) {
      case '=': return left === right
      case '!=': return left !== right
      case '<': return left < right
      case '<=': return left <= right
      case '>': return left > right
      case '>=': return left >= right
    }
  }

  /** All of them, or none — an empty list is a page with no conditions. */
  testAll(conditions: readonly Condition[]): boolean {
    return conditions.every((c) => this.test(c))
  }

  /** Everything that has been set, for the editor's panel. */
  snapshot(): { flags: [string, boolean][]; vars: [string, number][] } {
    return {
      flags: [...this.flags].sort((a, b) => a[0].localeCompare(b[0])),
      vars: [...this.vars].sort((a, b) => a[0].localeCompare(b[0])),
    }
  }

  clear(): void {
    if (this.flags.size === 0 && this.vars.size === 0) return
    this.flags.clear()
    this.vars.clear()
    this.version++
  }
}
