export { RecommendationList }

import { Badge } from "@ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/card"
import { type Recommendation } from "@module/profile/types"

const ROW_KEYS = ["author", "role", "company", "relationship", "date", "channel", "url", "text"] as const

// Nothing has been written into data/recommendations.yaml yet, so the empty
// state is the section's real content: it names the file and its keys rather
// than saying "nothing here".
function RecommendationList({ items }: { readonly items: readonly Recommendation[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center">
        <p className="text-sm font-medium text-foreground">No recommendations yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add rows under <code>recommendations:</code> in <code className="font-mono">data/recommendations.yaml</code>.
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
          {ROW_KEYS.map((key) => (
            <Badge key={key} variant="outline" className="font-mono">
              {key}
            </Badge>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      {items.map((item) => (
        <Card key={item.id}>
          <CardHeader>
            <CardTitle>{item.author}</CardTitle>
            <CardDescription>
              {item.role} · {item.company}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-1.5">
              {item.relationship !== "" && <Badge variant="outline">{item.relationship}</Badge>}
              {item.channel !== "" && <Badge variant="outline">{item.channel}</Badge>}
              <span className="text-xs text-muted-foreground">{item.date}</span>
            </div>
            {/* Verbatim by contract — never reflowed, never paraphrased. */}
            {item.text !== "" && (
              <blockquote className="mt-3 border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
                {item.text}
              </blockquote>
            )}
            {item.url !== "" && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block text-xs font-medium text-foreground underline-offset-4 hover:underline"
              >
                Open source
              </a>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
