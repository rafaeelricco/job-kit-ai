export { probe, type Probe, type ProbeFiles }

type ProbeFiles = {
  readonly candidate: boolean
  readonly jobSearch: boolean
}

type Probe = { readonly kind: "passed" } | { readonly kind: "failed"; readonly missing: readonly string[] }

function probe(files: ProbeFiles): Probe {
  const missing = [
    ...(files.candidate ? [] : ["data/candidate.yaml"]),
    ...(files.jobSearch ? [] : ["data/job_search.yaml"]),
  ]
  return missing.length === 0 ? { kind: "passed" } : { kind: "failed", missing }
}
