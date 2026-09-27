export {
  useForm,
  FormLabel,
  FormInput,
  TextInput,
  TextareaInput,
  DateInput,
  TimeInput,
  CheckboxInput,
  MoneyInput,
  ComboboxInput,
  SelectInput,
  TagsInput,
  RichTextInput,
  TextElementConfig,
  TextareaElementConfig,
  DateElementConfig,
  TimeElementConfig,
  CheckboxElementConfig,
  MoneyElementConfig,
  ComboboxElementConfig,
  SelectElementConfig,
  TagsElementConfig,
  RichTextElementConfig,
  type FormConfig,
  type FormErrors,
  type FormOutputs,
  type TextInputType,
}

import * as React from "react"

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import {
  Calendar03Icon,
  Cancel01Icon,
  Clock01Icon,
  DollarCircleIcon,
  Heading02Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  TextBoldIcon,
  TextItalicIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons"
import { useEditor, EditorContent, type Editor, type JSONContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { fromNullable, fromOptional, type Maybe, Nothing } from "@lib/maybe"
import { DateOnly, TimeOfDay } from "@lib/time"
import { Money } from "@lib/money"
import { type ReactNode, useMemo, useState } from "react"
import { Button } from "@ui/button"
import { Input } from "@ui/input"
import { Textarea } from "@ui/textarea"
import { Checkbox } from "@ui/checkbox"
import { Calendar } from "@ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@ui/popover"
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@ui/command"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select"
import { Label } from "@ui/label"
import { cn } from "@components/utils"
import { search } from "@lib/fuzzy"

// ============ Type plumbing ================
type ItemConfig =
  | TextInput
  | TextareaInput
  | RichTextInput
  | DateInput
  | TimeInput
  | CheckboxInput
  | MoneyInput
  | ComboboxInputBase
  | SelectInputBase
  | TagsInput

type ItemProps<T> =
  T extends TextInput ? TextElementConfig
  : T extends RichTextInput ? RichTextElementConfig
  : T extends TextareaInput ? TextareaElementConfig
  : T extends DateInput ? DateElementConfig
  : T extends TimeInput ? TimeElementConfig
  : T extends CheckboxInput ? CheckboxElementConfig
  : T extends MoneyInput ? MoneyElementConfig
  : T extends SelectInputBase ? SelectElementConfig
  : T extends ComboboxInputBase ? ComboboxElementConfig
  : T extends TagsInput ? TagsElementConfig
  : never

type ItemState<T extends ItemConfig> =
  T extends TextInput ? TextItemState
  : T extends RichTextInput ? RichTextItemState
  : T extends TextareaInput ? TextareaItemState
  : T extends DateInput ? DateItemState
  : T extends TimeInput ? TimeItemState
  : T extends CheckboxInput ? CheckboxItemState
  : T extends MoneyInput ? MoneyItemState
  : T extends SelectInputBase ? SelectItemState
  : T extends ComboboxInputBase ? ComboboxItemState
  : T extends TagsInput ? TagsItemState
  : never

type ItemOutput<T> =
  T extends TextInput ? string
  : T extends RichTextInput ? string
  : T extends TextareaInput ? string
  : T extends DateInput ? DateOnly | null
  : T extends TimeInput ? TimeOfDay | null
  : T extends CheckboxInput ? boolean
  : T extends MoneyInput ? Money | null
  : T extends SelectInputBase ? string | null
  : T extends ComboboxInputBase ? string | null
  : T extends TagsInput ? string[]
  : never

type AnyElementConfig = ItemProps<ItemConfig>
type FormInputs = Record<string, ItemConfig>
type FormState<T extends FormInputs> = { [K in keyof T]: ItemState<T[K]> }
type FormProps<T extends FormInputs> = { [K in keyof T]: ItemProps<T[K]> }
type FormOutputs<T extends FormInputs> = { [K in keyof T]: ItemOutput<T[K]> }
type FormErrors<T extends FormInputs> = { [K in keyof T]: string | null }
type DerivableKeys<T extends FormInputs> = { [K in keyof T]: T[K] extends TextInput ? K : never }[keyof T]
type FormDerive<T extends FormInputs> = (v: FormOutputs<T>) => Partial<Record<DerivableKeys<T>, string>>
type FormConfig<T extends FormInputs> = {
  fields: T
  validate?: (v: FormOutputs<NoInfer<T>>) => FormErrors<NoInfer<T>>
  derive?: FormDerive<NoInfer<T>>
}

type SubmitEventListener = (e?: { preventDefault(): void }) => Promise<void>
type OnSubmit<T extends FormInputs> = (f: (v: FormOutputs<T>) => void | Promise<void>) => SubmitEventListener
type HookReturn<T extends FormInputs> = {
  onSubmit: OnSubmit<T>
  fields: FormProps<T>
  values: FormOutputs<T>
  reset: () => void
}

// ============ Text ================
type TextInputType = NonNullable<React.ComponentProps<typeof Input>["type"]>
/** Native attributes passed straight to the `<input>`; autofill hints and length caps the config cannot infer. */
type TextInputAttrs = Pick<React.ComponentProps<typeof Input>, "autoComplete" | "inputMode" | "maxLength" | "autoFocus">

class TextInput {
  readonly values: {
    label: ReactNode
    hideLabel?: boolean
    description?: ReactNode
    type: TextInputType
    defaultValue: string
    placeholder?: string
    icon?: IconSvgElement
    input?: TextInputAttrs
  }
  constructor(values: {
    label: ReactNode
    hideLabel?: boolean
    description?: ReactNode
    type: TextInputType
    defaultValue: string
    placeholder?: string
    icon?: IconSvgElement
    input?: TextInputAttrs
  }) {
    this.values = values
  }
}

class TextItemState {
  readonly values: { value: string; error: Maybe<string> }
  constructor(values: { value: string; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): string {
    return this.values.value
  }
}

class TextElementConfig {
  readonly values: {
    name: string
    id: string
    value: string
    type: TextInputType
    label: ReactNode
    hideLabel: boolean
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    icon: Maybe<IconSvgElement>
    input: TextInputAttrs
    error: Maybe<string>
    onChange: (value: string) => void
  }
  constructor(values: {
    name: string
    id: string
    value: string
    type: TextInputType
    label: ReactNode
    hideLabel: boolean
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    icon: Maybe<IconSvgElement>
    input: TextInputAttrs
    error: Maybe<string>
    onChange: (value: string) => void
  }) {
    this.values = values
  }
}

// ============ Textarea ================
class TextareaInput {
  readonly values: {
    label: ReactNode
    description?: ReactNode
    defaultValue: string
    placeholder?: string
    rows?: number
  }
  constructor(values: {
    label: ReactNode
    description?: ReactNode
    defaultValue: string
    placeholder?: string
    rows?: number
  }) {
    this.values = values
  }
}

class TextareaItemState {
  readonly values: { value: string; error: Maybe<string> }
  constructor(values: { value: string; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): string {
    return this.values.value
  }
}

class TextareaElementConfig {
  readonly values: {
    name: string
    id: string
    value: string
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    rows: number
    error: Maybe<string>
    onChange: (value: string) => void
  }
  constructor(values: {
    name: string
    id: string
    value: string
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    rows: number
    error: Maybe<string>
    onChange: (value: string) => void
  }) {
    this.values = values
  }
}

// ============ RichText ================
type RichTextMode = "html" | "text"

class RichTextInput {
  readonly values: {
    label: ReactNode
    description?: ReactNode
    mode: RichTextMode
    defaultValue: string
  }
  constructor(values: { label: ReactNode; description?: ReactNode; mode: RichTextMode; defaultValue: string }) {
    this.values = values
  }
}

class RichTextItemState {
  readonly values: { value: string; error: Maybe<string> }
  constructor(values: { value: string; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): string {
    return this.values.value
  }
}

class RichTextElementConfig {
  readonly values: {
    name: string
    id: string
    value: string
    mode: RichTextMode
    label: ReactNode
    description: Maybe<ReactNode>
    error: Maybe<string>
    onChange: (value: string) => void
  }
  constructor(values: {
    name: string
    id: string
    value: string
    mode: RichTextMode
    label: ReactNode
    description: Maybe<ReactNode>
    error: Maybe<string>
    onChange: (value: string) => void
  }) {
    this.values = values
  }
}

// ============ Date (DateOnly) ================
class DateInput {
  readonly values: {
    label: ReactNode
    description?: ReactNode
    defaultValue: DateOnly | null
    placeholder?: string
    onChange?: (value: DateOnly | null) => void
  }
  constructor(values: {
    label: ReactNode
    description?: ReactNode
    defaultValue: DateOnly | null
    placeholder?: string
    onChange?: (value: DateOnly | null) => void
  }) {
    this.values = values
  }
}

class DateItemState {
  readonly values: { value: DateOnly | null; error: Maybe<string> }
  constructor(values: { value: DateOnly | null; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): DateOnly | null {
    return this.values.value
  }
}

class DateElementConfig {
  readonly values: {
    name: string
    id: string
    value: DateOnly | null
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    error: Maybe<string>
    onChange: (value: DateOnly | null) => void
  }
  constructor(values: {
    name: string
    id: string
    value: DateOnly | null
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    error: Maybe<string>
    onChange: (value: DateOnly | null) => void
  }) {
    this.values = values
  }
}

// ============ Time (TimeOfDay) ================
class TimeInput {
  readonly values: {
    label: ReactNode
    description?: ReactNode
    defaultValue: TimeOfDay | null
    placeholder?: string
    step?: number
  }
  constructor(values: {
    label: ReactNode
    description?: ReactNode
    defaultValue: TimeOfDay | null
    placeholder?: string
    step?: number
  }) {
    this.values = values
  }
}

class TimeItemState {
  readonly values: { value: TimeOfDay | null; error: Maybe<string> }
  constructor(values: { value: TimeOfDay | null; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): TimeOfDay | null {
    return this.values.value
  }
}

class TimeElementConfig {
  readonly values: {
    name: string
    id: string
    value: TimeOfDay | null
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    step: number
    error: Maybe<string>
    onChange: (value: TimeOfDay | null) => void
  }
  constructor(values: {
    name: string
    id: string
    value: TimeOfDay | null
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    step: number
    error: Maybe<string>
    onChange: (value: TimeOfDay | null) => void
  }) {
    this.values = values
  }
}

// ============ Checkbox ================
class CheckboxInput {
  readonly values: {
    label: ReactNode
    description?: ReactNode
    defaultValue: boolean
  }
  constructor(values: { label: ReactNode; description?: ReactNode; defaultValue: boolean }) {
    this.values = values
  }
}

class CheckboxItemState {
  readonly values: { value: boolean; error: Maybe<string> }
  constructor(values: { value: boolean; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): boolean {
    return this.values.value
  }
}

class CheckboxElementConfig {
  readonly values: {
    name: string
    id: string
    value: boolean
    label: ReactNode
    description: Maybe<ReactNode>
    error: Maybe<string>
    onCheckedChange: (checked: boolean) => void
  }
  constructor(values: {
    name: string
    id: string
    value: boolean
    label: ReactNode
    description: Maybe<ReactNode>
    error: Maybe<string>
    onCheckedChange: (checked: boolean) => void
  }) {
    this.values = values
  }
}

// ============ Money ================
// Captures a major-unit (dollar) amount as free text and emits a `Money` (or null when blank).
// Currency is fixed to USD for the pilot — the only supported currency today.
class MoneyInput {
  readonly values: {
    label: ReactNode
    description?: ReactNode
    defaultValue: Money | null
    placeholder?: string
  }
  constructor(values: { label: ReactNode; description?: ReactNode; defaultValue: Money | null; placeholder?: string }) {
    this.values = values
  }
}

class MoneyItemState {
  // Holds the raw dollar text so in-progress entry (e.g. "12." or "") survives keystrokes;
  // the Money value is derived on read.
  readonly values: { value: string; error: Maybe<string> }
  constructor(values: { value: string; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): Money | null {
    // Tolerate currency symbols, thousands separators, and whitespace so a value like "$5,000.00"
    // isn't silently dropped (Number("5,000") is NaN). Empty, non-numeric or non-finite ("1e309") input reads as "unset".
    const cleaned = this.values.value.replace(/[$,\s]/g, "")
    if (cleaned === "") return null
    const dollars = Number(cleaned)
    if (!Number.isFinite(dollars)) return null
    return Money.USD(dollars)
  }
}

class MoneyElementConfig {
  readonly values: {
    name: string
    id: string
    value: string
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    error: Maybe<string>
    onChange: (value: string) => void
  }
  constructor(values: {
    name: string
    id: string
    value: string
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    error: Maybe<string>
    onChange: (value: string) => void
  }) {
    this.values = values
  }
}

function moneyToInputValue(money: Money | null): string {
  return money == null ? "" : String(money.amount)
}

// ============ Combobox ================
type ComboboxValues<T> = {
  label: ReactNode
  description?: ReactNode
  items: readonly T[]
  defaultValue: string | null
  getValue: (item: T) => string
  getLabel: (item: T) => ReactNode
  getKey?: (item: T) => string
  itemToString?: (item: T) => string
  placeholder?: string
  emptyMessage?: string
  allowClear?: boolean
}

class ComboboxInputBase {
  // Discriminates the two otherwise structurally identical configs in `ItemProps` and friends.
  readonly kind = "combobox"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type-erased base; ComboboxInput<T> narrows this.
  readonly values: ComboboxValues<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type-erased base; ComboboxInput<T> narrows this.
  constructor(values: ComboboxValues<any>) {
    this.values = values
  }
}

class ComboboxInput<T> extends ComboboxInputBase {
  constructor(values: ComboboxValues<T>) {
    super(values)
  }

  declare values: ComboboxValues<T>
}

class ComboboxItemState {
  readonly values: { value: string | null; error: Maybe<string> }
  constructor(values: { value: string | null; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): string | null {
    return this.values.value
  }
}

type ComboboxElementValues = {
  name: string
  id: string
  items: readonly unknown[]
  value: string | null
  label: ReactNode
  description: Maybe<ReactNode>
  placeholder: Maybe<string>
  emptyMessage: string
  allowClear: boolean
  getValue: (item: unknown) => string
  getLabel: (item: unknown) => ReactNode
  getKey: (item: unknown) => string
  itemToString: (item: unknown) => string
  error: Maybe<string>
  onChange: (value: string | null) => void
}

class ComboboxElementConfig {
  readonly values: ComboboxElementValues
  constructor(values: ComboboxElementValues) {
    this.values = values
  }
}

function comboboxItemToString<T>(
  getValue: (item: T) => string,
  getLabel: (item: T) => ReactNode,
  itemToString: ((item: T) => string) | undefined
): (item: T) => string {
  if (itemToString) return itemToString
  return (item) => {
    const label = getLabel(item)
    return typeof label === "string" ? label : getValue(item)
  }
}

// ============ Select ================
type SelectValues<T> = {
  label: ReactNode
  description?: ReactNode
  items: readonly T[]
  defaultValue: string | null
  getValue: (item: T) => string
  getLabel: (item: T) => ReactNode
  getKey?: (item: T) => string
  placeholder?: string
  allowClear?: boolean
}

class SelectInputBase {
  // Discriminates the two otherwise structurally identical configs in `ItemProps` and friends.
  readonly kind = "select"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type-erased base; SelectInput<T> narrows this.
  readonly values: SelectValues<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type-erased base; SelectInput<T> narrows this.
  constructor(values: SelectValues<any>) {
    this.values = values
  }
}

class SelectInput<T> extends SelectInputBase {
  constructor(values: SelectValues<T>) {
    super(values)
  }

  declare values: SelectValues<T>
}

class SelectItemState {
  readonly values: { value: string | null; error: Maybe<string> }
  constructor(values: { value: string | null; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): string | null {
    return this.values.value
  }
}

type SelectElementValues = {
  name: string
  id: string
  items: readonly unknown[]
  value: string | null
  label: ReactNode
  description: Maybe<ReactNode>
  placeholder: Maybe<string>
  allowClear: boolean
  getValue: (item: unknown) => string
  getLabel: (item: unknown) => ReactNode
  getKey: (item: unknown) => string
  error: Maybe<string>
  onChange: (value: string | null) => void
}

class SelectElementConfig {
  readonly values: SelectElementValues
  constructor(values: SelectElementValues) {
    this.values = values
  }
}

// ============ Tags ================
class TagsInput {
  readonly values: {
    label: ReactNode
    description?: ReactNode
    defaultValue: string[]
    placeholder?: string
  }
  constructor(values: { label: ReactNode; description?: ReactNode; defaultValue: string[]; placeholder?: string }) {
    this.values = values
  }
}

class TagsItemState {
  readonly values: { value: string[]; error: Maybe<string> }
  constructor(values: { value: string[]; error: Maybe<string> }) {
    this.values = values
  }
  getValue(): string[] {
    return this.values.value
  }
}

class TagsElementConfig {
  readonly values: {
    name: string
    id: string
    value: string[]
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    error: Maybe<string>
    onChange: (value: string[]) => void
  }
  constructor(values: {
    name: string
    id: string
    value: string[]
    label: ReactNode
    description: Maybe<ReactNode>
    placeholder: Maybe<string>
    error: Maybe<string>
    onChange: (value: string[]) => void
  }) {
    this.values = values
  }
}

// ============ Dispatch ================
type SetState<T extends ItemConfig> = (v: ItemState<T>) => void

function getInitialState(config: ItemConfig): ItemState<ItemConfig> {
  if (config instanceof TextInput) {
    return new TextItemState({ value: config.values.defaultValue, error: Nothing() })
  }
  if (config instanceof TextareaInput) {
    return new TextareaItemState({ value: config.values.defaultValue, error: Nothing() })
  }
  if (config instanceof RichTextInput) {
    return new RichTextItemState({ value: config.values.defaultValue, error: Nothing() })
  }
  if (config instanceof DateInput) {
    return new DateItemState({ value: config.values.defaultValue, error: Nothing() })
  }
  if (config instanceof TimeInput) {
    return new TimeItemState({ value: config.values.defaultValue, error: Nothing() })
  }
  if (config instanceof CheckboxInput) {
    return new CheckboxItemState({ value: config.values.defaultValue, error: Nothing() })
  }
  if (config instanceof MoneyInput) {
    return new MoneyItemState({ value: moneyToInputValue(config.values.defaultValue), error: Nothing() })
  }
  if (config instanceof ComboboxInputBase) {
    return new ComboboxItemState({ value: config.values.defaultValue, error: Nothing() })
  }
  if (config instanceof SelectInputBase) {
    return new SelectItemState({ value: config.values.defaultValue, error: Nothing() })
  }
  if (config instanceof TagsInput) {
    return new TagsItemState({ value: [...config.values.defaultValue], error: Nothing() })
  }
  return config satisfies never
}

function buildProps(
  name: string,
  id: string,
  config: ItemConfig,
  state: ItemState<ItemConfig>,
  setState: SetState<ItemConfig>
): ItemProps<ItemConfig> {
  if (config instanceof TextInput) {
    const { value, error } = (state as TextItemState).values
    const { label, hideLabel, placeholder, type, description, icon, input } = config.values
    return new TextElementConfig({
      name,
      id,
      value,
      label,
      hideLabel: hideLabel ?? false,
      type,
      description: fromOptional(description),
      placeholder: fromOptional(placeholder),
      icon: fromOptional(icon),
      input: input ?? {},
      error,
      onChange: (text) => setState(new TextItemState({ value: text, error })),
    })
  }
  if (config instanceof TextareaInput) {
    const { value, error } = (state as TextareaItemState).values
    const { label, placeholder, description, rows } = config.values
    return new TextareaElementConfig({
      name,
      id,
      value,
      label,
      description: fromOptional(description),
      placeholder: fromOptional(placeholder),
      rows: rows ?? 3,
      error,
      onChange: (text) => setState(new TextareaItemState({ value: text, error })),
    })
  }
  if (config instanceof RichTextInput) {
    const { value, error } = (state as RichTextItemState).values
    const { label, description, mode } = config.values
    return new RichTextElementConfig({
      name,
      id,
      value,
      mode,
      label,
      description: fromOptional(description),
      error,
      onChange: (next) => setState(new RichTextItemState({ value: next, error })),
    })
  }
  if (config instanceof DateInput) {
    const { value, error } = (state as DateItemState).values
    const { label, description, placeholder, onChange: onValueChange } = config.values
    return new DateElementConfig({
      name,
      id,
      value,
      label,
      description: fromOptional(description),
      placeholder: fromOptional(placeholder),
      error,
      onChange: (d) => {
        onValueChange?.(d)
        setState(new DateItemState({ value: d, error }))
      },
    })
  }
  if (config instanceof TimeInput) {
    const { value, error } = (state as TimeItemState).values
    const { label, description, placeholder, step } = config.values
    return new TimeElementConfig({
      name,
      id,
      value,
      label,
      description: fromOptional(description),
      placeholder: fromOptional(placeholder),
      step: step ?? 60,
      error,
      onChange: (t) => setState(new TimeItemState({ value: t, error })),
    })
  }
  if (config instanceof CheckboxInput) {
    const { value, error } = (state as CheckboxItemState).values
    const { label, description } = config.values
    return new CheckboxElementConfig({
      name,
      id,
      value,
      label,
      description: fromOptional(description),
      error,
      onCheckedChange: (checked) => setState(new CheckboxItemState({ value: checked, error })),
    })
  }
  if (config instanceof MoneyInput) {
    const { value, error } = (state as MoneyItemState).values
    const { label, description, placeholder } = config.values
    return new MoneyElementConfig({
      name,
      id,
      value,
      label,
      description: fromOptional(description),
      placeholder: fromOptional(placeholder),
      error,
      onChange: (next) => setState(new MoneyItemState({ value: next, error })),
    })
  }
  if (config instanceof ComboboxInputBase) {
    const { value, error } = (state as ComboboxItemState).values
    const {
      label,
      description,
      items,
      getValue,
      getLabel,
      getKey,
      itemToString,
      placeholder,
      emptyMessage,
      allowClear,
    } = config.values
    return new ComboboxElementConfig({
      name,
      id,
      items,
      value,
      label,
      description: fromOptional(description),
      placeholder: fromOptional(placeholder),
      emptyMessage: emptyMessage ?? "No items found.",
      allowClear: allowClear ?? true,
      getValue,
      getLabel,
      getKey: getKey ?? getValue,
      itemToString: comboboxItemToString(getValue, getLabel, itemToString),
      error,
      onChange: (next) => setState(new ComboboxItemState({ value: next, error })),
    })
  }
  if (config instanceof SelectInputBase) {
    const { value, error } = (state as SelectItemState).values
    const { label, description, items, getValue, getLabel, getKey, placeholder, allowClear } = config.values
    return new SelectElementConfig({
      name,
      id,
      items,
      value,
      label,
      description: fromOptional(description),
      placeholder: fromOptional(placeholder),
      allowClear: allowClear ?? false,
      getValue,
      getLabel,
      getKey: getKey ?? getValue,
      error,
      onChange: (next) => setState(new SelectItemState({ value: next, error })),
    })
  }
  if (config instanceof TagsInput) {
    const { value, error } = (state as TagsItemState).values
    const { label, description, placeholder } = config.values
    return new TagsElementConfig({
      name,
      id,
      value,
      label,
      description: fromOptional(description),
      placeholder: fromOptional(placeholder),
      error,
      onChange: (next) => setState(new TagsItemState({ value: next, error })),
    })
  }
  return config satisfies never
}

function withError(error: Maybe<string>, s: ItemState<ItemConfig>): ItemState<ItemConfig> {
  if (s instanceof TextItemState) return new TextItemState({ value: s.values.value, error })
  if (s instanceof TextareaItemState) return new TextareaItemState({ value: s.values.value, error })
  if (s instanceof RichTextItemState) return new RichTextItemState({ value: s.values.value, error })
  if (s instanceof DateItemState) return new DateItemState({ value: s.values.value, error })
  if (s instanceof TimeItemState) return new TimeItemState({ value: s.values.value, error })
  if (s instanceof CheckboxItemState) return new CheckboxItemState({ value: s.values.value, error })
  if (s instanceof MoneyItemState) return new MoneyItemState({ value: s.values.value, error })
  if (s instanceof ComboboxItemState) return new ComboboxItemState({ value: s.values.value, error })
  if (s instanceof SelectItemState) return new SelectItemState({ value: s.values.value, error })
  if (s instanceof TagsItemState) return new TagsItemState({ value: s.values.value, error })
  return s satisfies never
}

// ============ Form helpers ================
function initialState<T extends FormInputs>(fields: T): FormState<T> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) {
    result[key] = getInitialState(fields[key]!)
  }
  return result as FormState<T>
}

function getValues<T extends FormInputs>(state: FormState<T>): FormOutputs<T> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(state)) {
    result[key] = state[key]!.getValue()
  }
  return result as FormOutputs<T>
}

function updateErrors<T extends FormInputs>(errs: FormErrors<T>, state: FormState<T>): FormState<T> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(state)) {
    result[key] = withError(fromNullable(errs[key] ?? null), state[key]! as ItemState<ItemConfig>)
  }
  return result as FormState<T>
}

function noErrors<T extends FormInputs>(values: FormOutputs<T>): FormErrors<T> {
  const result: Record<string, null> = {}
  for (const key of Object.keys(values)) {
    result[key] = null
  }
  return result as FormErrors<T>
}

function applyDerive<T extends FormInputs>(
  state: FormState<T>,
  touched: ReadonlySet<string>,
  derive: FormDerive<T> | undefined
): FormState<T> {
  if (!derive) return state
  const overrides = derive(getValues(state))
  const result: Record<string, unknown> = { ...state }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string" || touched.has(key)) continue
    const current = state[key]!
    if (current instanceof TextItemState) {
      result[key] = new TextItemState({ value, error: current.values.error })
    }
  }
  return result as FormState<T>
}

// ============ useForm ================
/**
 * `fields` is read once, on mount: keep the same keys for the life of the form.
 * For conditional fields, give the form component a React `key` that changes with
 * the field set so it remounts with fresh state.
 */
function useForm<T extends FormInputs>({ fields, validate = noErrors, derive }: FormConfig<T>): HookReturn<T> {
  const initial = useMemo(() => initialState(fields), [fields])
  const [state, setState] = useState(initial)
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())
  const [validateOnChange, setValidateOnChange] = useState(false)
  // Prefix DOM ids per form so two forms sharing a field key don't collide; `name` stays the bare key.
  const formId = React.useId()

  const effective = applyDerive(state, touched, derive)

  const props: Record<string, AnyElementConfig> = {}
  for (const key of Object.keys(fields)) {
    props[key] = buildProps(key, `${formId}-${key}`, fields[key]!, effective[key]! as never, (s) => {
      const isEmptyText = s instanceof TextItemState && s.values.value === ""
      const nextTouched: ReadonlySet<string> =
        isEmptyText ?
          touched.has(key) ?
            new Set([...touched].filter((k) => k !== key))
          : touched
        : touched.has(key) ? touched
        : new Set(touched).add(key)
      setTouched(nextTouched)
      setState((current) => {
        const next = { ...current, [key]: s } as FormState<T>
        if (validateOnChange) {
          return updateErrors(validate(getValues(applyDerive(next, nextTouched, derive))), next)
        }
        return next
      })
    })
  }

  const values = getValues(effective)

  const onSubmit: OnSubmit<T> = (f) => async (e) => {
    e?.preventDefault()
    setValidateOnChange(true)
    const errors = validate(values)
    setState((s) => updateErrors(errors, s))
    if (Object.values(errors).every((v) => v === null)) {
      await f(values)
    }
  }

  const reset = (): void => {
    setState(initial)
    setTouched(new Set())
    setValidateOnChange(false)
  }

  return { onSubmit, fields: props as FormProps<T>, values, reset }
}

// ============ Shared UI ================
function FormLabel({
  label,
  hideLabel = false,
  description,
  children,
  htmlFor,
}: {
  label: ReactNode
  hideLabel?: boolean
  htmlFor: string
  description: Maybe<ReactNode>
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      {typeof label === "string" ?
        <Label htmlFor={htmlFor} className={cn(hideLabel && "sr-only")}>
          {label}
        </Label>
      : label}
      {description.maybe(null, (d) => (
        <p className="text-sm text-muted-foreground">{d}</p>
      ))}
      {children}
    </div>
  )
}

type FormInputProps = {
  config: AnyElementConfig
  className?: string | undefined
  disabled?: boolean | undefined
}

// ============ Field UI ================
function FormTextField({
  config,
  className,
  disabled,
}: {
  config: TextElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const { name, id, value, type, label, hideLabel, description, placeholder, icon, input, error, onChange } =
    config.values
  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)
  const hasIcon = icon.maybe(false, () => true)
  const showClear = type === "search" && value.length > 0
  const needsWrapper = hasIcon || type === "search"

  const inputEl = (
    <Input
      {...input}
      id={id}
      name={name}
      value={value}
      className={cn(
        hasIcon && "pl-9",
        showClear && "pr-8",
        type === "search" && "[&::-webkit-search-cancel-button]:hidden",
        className
      )}
      placeholder={placeholder.withDefault("")}
      disabled={disabled}
      type={type}
      aria-invalid={hasError}
      aria-describedby={hasError ? errorId : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  )

  return (
    <FormLabel htmlFor={id} label={label} hideLabel={hideLabel} description={description}>
      {needsWrapper ?
        <div className="relative">
          {icon.maybe(null, (Icon) => (
            <HugeiconsIcon
              icon={Icon}
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
          ))}
          {inputEl}
          {showClear && (
            <button
              type="button"
              onClick={() => {
                if (!disabled) onChange("")
              }}
              aria-label="Clear search"
              className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
              disabled={disabled}
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
            </button>
          )}
        </div>
      : inputEl}
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </FormLabel>
  )
}

function FormTextareaField({
  config,
  className,
  disabled,
}: {
  config: TextareaElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const { name, id, value, label, description, placeholder, rows, error, onChange } = config.values
  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)

  return (
    <FormLabel htmlFor={id} label={label} description={description}>
      <Textarea
        id={id}
        name={name}
        value={value}
        rows={rows}
        className={cn(className)}
        placeholder={placeholder.withDefault("")}
        disabled={disabled}
        aria-invalid={hasError}
        aria-describedby={hasError ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </FormLabel>
  )
}

function RichTextToolbarButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: IconSvgElement
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn("size-8", active && "bg-muted text-foreground")}
    >
      <HugeiconsIcon icon={icon} className="size-4" />
    </Button>
  )
}

function RichTextToolbar({ editor }: { editor: Editor }) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border p-1">
      <RichTextToolbarButton
        label="Bold"
        icon={TextBoldIcon}
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <RichTextToolbarButton
        label="Italic"
        icon={TextItalicIcon}
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <RichTextToolbarButton
        label="Heading"
        icon={Heading02Icon}
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <RichTextToolbarButton
        label="Bullet list"
        icon={LeftToRightListBulletIcon}
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <RichTextToolbarButton
        label="Numbered list"
        icon={LeftToRightListNumberIcon}
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
    </div>
  )
}

/** One paragraph per line, so `getText({ blockSeparator: "\n" })` returns the value unchanged. */
function plainTextDocument(value: string): JSONContent {
  return {
    type: "doc",
    content: value.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  }
}

function FormRichTextField({
  config,
  className,
  disabled,
}: {
  config: RichTextElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const { id, value, mode, label, description, error, onChange } = config.values
  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)

  const attributes = {
    id,
    class: cn(
      "min-h-24 px-3.5 py-3 text-sm outline-none",
      "[&_a]:text-primary [&_a]:underline [&_em]:italic [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-medium [&_hr]:my-3 [&_hr]:border-border [&_li]:mb-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5"
    ),
    "aria-invalid": String(hasError),
    ...(hasError ? { "aria-describedby": errorId } : {}),
  }

  const editor = useEditor({
    extensions: [StarterKit],
    // Text mode must not go through Tiptap's HTML parser, or markup in the value renders and newlines collapse.
    content: mode === "html" ? value : plainTextDocument(value),
    editable: !disabled,
    onUpdate: ({ editor }) =>
      onChange(
        editor.isEmpty ? ""
        : mode === "html" ? editor.getHTML()
        : editor.getText({ blockSeparator: "\n" })
      ),
    editorProps: { attributes },
  })

  React.useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  React.useEffect(() => {
    editor?.setOptions({ editorProps: { attributes } })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `attributes` is rebuilt every render from these inputs
  }, [editor, id, hasError, errorId])

  return (
    <FormLabel htmlFor={id} label={label} description={description}>
      <div
        aria-invalid={hasError}
        className={cn(
          "border border-input bg-input-surface focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
          hasError && "border-destructive",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        {mode === "html" && editor && <RichTextToolbar editor={editor} />}
        <EditorContent editor={editor} />
      </div>
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </FormLabel>
  )
}

function FormDateField({
  config,
  className,
  disabled,
}: {
  config: DateElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const { id, value, label, description, placeholder, error, onChange } = config.values
  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)
  const [open, setOpen] = useState(false)
  const selectedJs = value ? new Date(value.year, value.month - 1, value.day) : undefined

  return (
    <FormLabel htmlFor={id} label={label} description={description}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              disabled={disabled}
              aria-invalid={hasError}
              aria-describedby={hasError ? errorId : undefined}
              className={cn(
                "w-full justify-start text-left font-normal",
                !value && "text-muted-foreground",
                hasError && "border-destructive",
                className
              )}
            />
          }
        >
          <HugeiconsIcon icon={Calendar03Icon} className="mr-2 size-4" />
          {value ? value.pretty() : placeholder.withDefault("Pick a date")}
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selectedJs}
            defaultMonth={selectedJs ?? new Date()}
            captionLayout="dropdown"
            onSelect={(d) => {
              onChange(d ? new DateOnly(d.getFullYear(), d.getMonth() + 1, d.getDate()) : null)
              setOpen(false)
            }}
          />
          {value && (
            <div className="border-t border-border p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => {
                  onChange(null)
                  setOpen(false)
                }}
              >
                Clear date
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </FormLabel>
  )
}

function timeOfDayToInputValue(t: TimeOfDay | null, step: number): string {
  if (t == null) return ""
  const full = t.pretty()
  // Drop seconds only when neither the step nor the value uses them, so the input never hides data it submits.
  return step % 60 === 0 && t.seconds % 60 === 0 ? full.slice(0, 5) : full
}

function inputValueToTimeOfDay(value: string): TimeOfDay | null {
  if (!value) return null
  const [h, m, s = "0"] = value.split(":")
  const hours = Number(h)
  const minutes = Number(m)
  const seconds = Number(s)
  if ([hours, minutes, seconds].some(Number.isNaN)) return null
  return TimeOfDay.fromParts({ hours, minutes, seconds })
}

function FormTimeField({
  config,
  className,
  disabled,
}: {
  config: TimeElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const { name, id, value, label, description, step, error, onChange } = config.values
  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)

  return (
    <FormLabel htmlFor={id} label={label} description={description}>
      <div className="relative">
        <HugeiconsIcon
          icon={Clock01Icon}
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={id}
          name={name}
          type="time"
          step={step}
          disabled={disabled}
          aria-invalid={hasError}
          aria-describedby={hasError ? errorId : undefined}
          value={timeOfDayToInputValue(value, step)}
          onChange={(e) => onChange(inputValueToTimeOfDay(e.target.value))}
          className={cn(
            "appearance-none pl-8 [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none",
            hasError && "border-destructive",
            className
          )}
        />
      </div>
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </FormLabel>
  )
}

function FormCheckboxField({
  config,
  disabled,
}: {
  config: CheckboxElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const { name, id, value, label, description, error, onCheckedChange } = config.values
  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)
  const checkboxId = `${id}-checkbox`

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id={checkboxId}
          name={name}
          checked={value}
          disabled={disabled}
          aria-invalid={hasError}
          aria-describedby={hasError ? errorId : undefined}
          onCheckedChange={(v) => onCheckedChange(v === true)}
        />
        {typeof label === "string" ?
          <Label htmlFor={checkboxId} className="cursor-pointer font-normal">
            {label}
          </Label>
        : label}
      </div>
      {description.maybe(null, (d) => (
        <p className="text-sm text-muted-foreground">{d}</p>
      ))}
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </div>
  )
}

function FormMoneyField({
  config,
  className,
  disabled,
}: {
  config: MoneyElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const { name, id, value, label, description, placeholder, error, onChange } = config.values
  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)

  return (
    <FormLabel htmlFor={id} label={label} description={description}>
      <div className="relative">
        <HugeiconsIcon
          icon={DollarCircleIcon}
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={id}
          name={name}
          type="text"
          inputMode="decimal"
          value={value}
          className={cn("pl-9", className)}
          placeholder={placeholder.withDefault("0.00")}
          disabled={disabled}
          aria-invalid={hasError}
          aria-describedby={hasError ? errorId : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </FormLabel>
  )
}

function FormComboboxField({
  config,
  className,
  disabled,
}: {
  config: ComboboxElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const {
    id,
    items,
    value,
    label,
    description,
    placeholder,
    emptyMessage,
    allowClear,
    getValue,
    getLabel,
    getKey,
    itemToString,
    error,
    onChange,
  } = config.values

  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selectedItem = items.find((item) => getValue(item) === value) ?? null

  // Cap how many options a form combobox mounts at once. Large datasets (e.g. legacy
  // venues) otherwise freeze the popover; users narrow past the cap by typing.
  const COMBOBOX_MAX_VISIBLE = 50

  // Bounded, fuzzy-ranked slice so large datasets don't mount thousands of
  // CommandItems and freeze the popover. Mirrors OrgCombobox.
  const ranked = useMemo(
    () => search(query, items, [itemToString], { caseSensitive: false }).map((r) => r.item),
    [query, items, itemToString]
  )
  const visible = ranked.slice(0, COMBOBOX_MAX_VISIBLE)
  const hiddenCount = ranked.length - visible.length

  return (
    <FormLabel htmlFor={id} label={label} description={description}>
      <Popover
        modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery("")
        }}
      >
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-invalid={hasError}
              aria-describedby={hasError ? errorId : undefined}
              disabled={disabled}
              className={cn(
                "w-full justify-between font-normal",
                !selectedItem && "text-muted-foreground",
                hasError && "border-destructive",
                className
              )}
            />
          }
        >
          <span className="truncate">{selectedItem ? getLabel(selectedItem) : placeholder.withDefault("Select…")}</span>
          <HugeiconsIcon icon={UnfoldMoreIcon} className="ml-2 size-4 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--anchor-width) p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder={"Search…"} className="h-9" value={query} onValueChange={setQuery} />
            <CommandList>
              {visible.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>}
              <CommandGroup>
                {visible.map((item) => {
                  const itemValue = getValue(item)
                  const isSelected = itemValue === value
                  return (
                    <CommandItem
                      key={getKey(item)}
                      value={itemValue}
                      data-checked={isSelected}
                      onSelect={(current) => {
                        const next = allowClear && current === value ? null : current
                        onChange(next)
                        setOpen(false)
                        setQuery("")
                      }}
                    >
                      {getLabel(item)}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
              {hiddenCount > 0 && (
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                  Showing first {visible.length} of {ranked.length}. Keep typing to narrow results.
                </p>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </FormLabel>
  )
}

function FormSelectField({
  config,
  className,
  disabled,
}: {
  config: SelectElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const {
    name,
    id,
    items,
    value,
    label,
    description,
    placeholder,
    allowClear,
    getValue,
    getLabel,
    getKey,
    error,
    onChange,
  } = config.values

  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)
  const showClear = allowClear && value !== null

  // Base UI Select reserves the empty string for placeholder/clear state and rejects empty item values.
  // SelectInput stores null for "no selection", so selected and option values must be non-empty strings.
  // When allowClear is true, generate an internal clear-row value that cannot collide with real option ids.
  const selectValue = value === null ? "" : selectNonEmptyValue(name, value)
  const selectItems = items.map((item) => {
    const itemValue = selectNonEmptyValue(name, getValue(item))
    return { key: getKey(item), label: getLabel(item), value: itemValue }
  })

  const optionValues = new Set(selectItems.map((item) => item.value))
  const clearValuePrefix = "__form_select_clear__"
  let clearValue = clearValuePrefix
  for (let index = 0; optionValues.has(clearValue); index += 1) {
    clearValue = `${clearValuePrefix}:${index}`
  }

  return (
    <FormLabel htmlFor={id} label={label} description={description}>
      <Select
        name={name}
        value={selectValue}
        items={selectItems.map((i) => ({ value: i.value, label: i.label }))}
        disabled={disabled ?? false}
        onValueChange={(next) => onChange(showClear && next === clearValue ? null : next)}
      >
        <SelectTrigger
          id={id}
          aria-invalid={hasError}
          aria-describedby={hasError ? errorId : undefined}
          className={cn("w-full", className)}
        >
          <SelectValue placeholder={placeholder.withDefault("Select…")} />
        </SelectTrigger>
        <SelectContent>
          {showClear && (
            <SelectItem value={clearValue} className="text-muted-foreground">
              Clear selection
            </SelectItem>
          )}
          {selectItems.map((item) => (
            <SelectItem key={item.key} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </FormLabel>
  )
}

function selectNonEmptyValue(name: string, value: string): string {
  if (value === "") {
    throw new Error(`SelectInput "${name}" values must be non-empty strings. Use null for no selection.`)
  }
  return value
}

function FormTagsField({
  config,
  className,
  disabled,
}: {
  config: TagsElementConfig
  className: string | undefined
  disabled: boolean | undefined
}) {
  const { name, id, value, label, description, placeholder, error, onChange } = config.values
  const [draft, setDraft] = useState("")
  const errorId = `${id}-error`
  const hasError = error.maybe(false, () => true)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    const exists = value.some((t) => t.toLowerCase() === trimmed.toLowerCase())
    if (!exists) onChange([...value, trimmed])
    setDraft("")
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      commit()
      return
    }
    if (e.key === "Backspace" && draft.length === 0 && value.length > 0) {
      e.preventDefault()
      onChange(value.slice(0, -1))
    }
  }

  return (
    <FormLabel htmlFor={id} label={label} description={description}>
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1.5 border border-input bg-input-surface px-3 text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 focus-within:outline-none dark:bg-input/30",
          hasError && "border-destructive",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-sm bg-muted px-2 py-0.5 text-sm text-muted-foreground"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (!disabled) onChange(value.filter((t) => t !== tag))
              }}
              className="hover:text-foreground disabled:cursor-not-allowed"
              aria-label={`Remove ${tag}`}
              disabled={disabled}
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          aria-invalid={hasError}
          aria-describedby={hasError ? errorId : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          placeholder={value.length === 0 ? placeholder.withDefault("") : undefined}
          disabled={disabled}
          className="min-w-20 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
      </div>
      {error.maybe(null, (e) => (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </FormLabel>
  )
}

// ============ FormInput ================
const FormInput: React.FC<FormInputProps> = ({ config, className, disabled }) => {
  if (config instanceof TextElementConfig) {
    return <FormTextField config={config} className={className} disabled={disabled} />
  }

  if (config instanceof TextareaElementConfig) {
    return <FormTextareaField config={config} className={className} disabled={disabled} />
  }

  if (config instanceof RichTextElementConfig) {
    return <FormRichTextField config={config} className={className} disabled={disabled} />
  }

  if (config instanceof DateElementConfig) {
    return <FormDateField config={config} className={className} disabled={disabled} />
  }

  if (config instanceof TimeElementConfig) {
    return <FormTimeField config={config} className={className} disabled={disabled} />
  }

  if (config instanceof CheckboxElementConfig) {
    return <FormCheckboxField config={config} className={className} disabled={disabled} />
  }

  if (config instanceof MoneyElementConfig) {
    return <FormMoneyField config={config} className={className} disabled={disabled} />
  }

  if (config instanceof ComboboxElementConfig) {
    return <FormComboboxField config={config} className={className} disabled={disabled} />
  }

  if (config instanceof SelectElementConfig) {
    return <FormSelectField config={config} className={className} disabled={disabled} />
  }

  if (config instanceof TagsElementConfig) {
    return <FormTagsField config={config} className={className} disabled={disabled} />
  }

  return config satisfies never
}
