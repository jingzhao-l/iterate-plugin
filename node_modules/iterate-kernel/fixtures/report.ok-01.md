# op_0PAAAABBBBCCCCDDDDEEEEFFFF · NO_ANOMALY · normal

**operationId**: op_0PAAAABBBBCCCCDDDDEEEEFFFF
**createdAt**: 2026-09-19T09:41:02.500Z
**schemaVersion**: glasspane.evidence/0.1
* attribution: strong | contaminated=false
* circuitBreaker: level 0 (normal)
* act press AXButton "OK Press" #ok-press: confirmed
* axEvent: changed=true nodes=24 latencyMs=1234.57
* handlerProbe: probeVersion=gp-probe/0.1.0 hitCount=3 late=1 handlers=[probe-demo/ProbeDemoApp.swift:64, probe-demo/ProbeDemoApp.swift:65]
* stateDiff: source=z3-kvc changed=true entries=[demo.count "0" -> "1", demo.label "idle" -> "pressed"]
* pixelDiff: changedRatio=0.123457 windowId=4210 bounds=12,34,96,28
* responsiveness: responsive=true pingMs=2.1
* crash: aliveBefore=true aliveAfter=true

## PATH

act.press -> probe-window -> handler/state -> ax-digest -> pixel-diff

## ANOMALY

none: operation confirmed, AX tree changed and pixels changed

## EVIDENCE

op_0PAAAABBBBCCCCDDDDEEEEFFFF strong attribution; actConfirmed=true

## NEXT

no action required; continue the recipe
