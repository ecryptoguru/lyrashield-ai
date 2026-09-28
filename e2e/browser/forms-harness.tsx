import { Input, Select, Textarea } from "@lyrashield/ui"
import { MyraPanel } from "../../apps/web/src/components/myra/myra-panel"

export default function FormsHarness() {
  return (
    <main>
      <label>
        Shared input
        <Input aria-label="Shared input" />
      </label>
      <label>
        Shared textarea
        <Textarea aria-label="Shared textarea" />
      </label>
      <label>
        Shared select
        <Select aria-label="Shared select">
          <option>One</option>
        </Select>
      </label>
      <MyraPanel />
    </main>
  )
}
