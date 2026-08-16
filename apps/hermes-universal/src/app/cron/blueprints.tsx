import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AutomationBlueprint, AutomationBlueprintField } from '@/hermes'

// The blueprint catalog is shared with the dashboard, so its deliver slot
// defaults to "origin" (the chat/home-channel a dashboard or gateway job was
// created from). This app has no origin chat, so seed the deliver slot to the
// app's native target ("local" = This device) instead. The dialog then renders
// that slot with the shared delivery control, so the raw "origin" option never
// reaches the UI.
const DELIVER_FIELD = 'deliver'
const LOCAL_DELIVER_DEFAULT = 'local'

function isDeliverField(field: AutomationBlueprintField): boolean {
  return field.name === DELIVER_FIELD
}

// Initial form state for a blueprint = each field's default (or ''). Pure so the
// suite can assert the form seeds correctly without mounting React. The deliver
// slot is special-cased: an "origin" default (or empty) becomes "local" so a
// locally-created job delivers to This device instead of nowhere.
export function initialBlueprintValues(blueprint: AutomationBlueprint): Record<string, string> {
  const out: Record<string, string> = {}

  for (const field of blueprint.fields) {
    const seeded = field.default ?? ''
    out[field.name] = isDeliverField(field) && (seeded === '' || seeded === 'origin') ? LOCAL_DELIVER_DEFAULT : seeded
  }

  return out
}

// A slot-level validation error from the backend arrives as "422: <message>"
// (or "<code>: <message>"); strip the leading numeric code for inline display.
export function cleanBlueprintFieldError(message: string): string {
  return message.replace(/^\d+:\s*/, '')
}

// Help text to show under a slot control. The backend deliver help is
// origin/dashboard-centric and even contradicts this app's semantics ("local =
// save only" vs. This device), and the delivery control is self-explanatory —
// skip it for the deliver slot.
export function blueprintSlotHelp(field: AutomationBlueprintField): string | undefined {
  return field.help && field.type !== 'text' && !isDeliverField(field) ? field.help : undefined
}

// Renders one blueprint slot's control (enum/weekdays → Select, time → time
// input, else text). The deliver slot is handled separately by the dialog's
// shared delivery control, so it's not rendered here.
export function BlueprintSlotControl({
  field,
  id,
  onChange,
  value
}: {
  field: AutomationBlueprintField
  id: string
  onChange: (next: string) => void
  value: string
}) {
  if (field.type === 'enum' || field.type === 'weekdays') {
    return (
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger className="h-9 rounded-md" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.options.map(option => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  if (field.type === 'time') {
    return <Input id={id} onChange={event => onChange(event.target.value)} type="time" value={value} />
  }

  return (
    <Input
      id={id}
      onChange={event => onChange(event.target.value)}
      placeholder={field.help || field.label}
      type="text"
      value={value}
    />
  )
}
