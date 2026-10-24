-------------------------- MODULE Model --------------------------
EXTENDS Naturals
CONSTANT MaxAttempts
ASSUME MaxAttempts \in Nat \ {0}
VARIABLES status, attempt, cancelAccepted, acceptedAttempt, pending
vars == <<status, attempt, cancelAccepted, acceptedAttempt, pending>>
Terminal == {"cancelled", "succeeded", "failed"}
Init == /\ status = "queued"
        /\ attempt = 0
        /\ cancelAccepted = FALSE
        /\ acceptedAttempt = 0
        /\ pending = {}
Start == /\ status = "queued"
         /\ status' = "running"
         /\ attempt' = 1
         /\ pending' = pending \cup {1}
         /\ UNCHANGED <<cancelAccepted, acceptedAttempt>>
Timeout == /\ status = "running"
           /\ status' = IF attempt < MaxAttempts THEN "waiting" ELSE "failed"
           /\ UNCHANGED <<attempt, cancelAccepted, acceptedAttempt, pending>>
Retry == /\ status = "waiting"
         /\ attempt < MaxAttempts
         /\ status' = "running"
         /\ attempt' = attempt + 1
         /\ pending' = pending \cup {attempt + 1}
         /\ UNCHANGED <<cancelAccepted, acceptedAttempt>>
Cancel == /\ status \notin Terminal
          /\ status' = "cancelled"
          /\ cancelAccepted' = TRUE
          /\ UNCHANGED <<attempt, acceptedAttempt, pending>>
Deliver(tag) == /\ tag \in pending
                /\ pending' = pending \ {tag}
                /\ IF status = "running" /\ tag = attempt
                    THEN /\ status' = "succeeded"
                         /\ acceptedAttempt' = tag
                    ELSE UNCHANGED <<status, acceptedAttempt>>
                /\ UNCHANGED <<attempt, cancelAccepted>>
TerminalStutter == /\ status \in Terminal
                   /\ UNCHANGED vars
Next == Start \/ Timeout \/ Retry \/ Cancel \/ (\E tag \in pending : Deliver(tag)) \/ TerminalStutter
Spec == Init /\ [][Next]_vars
TypeOK == /\ pending \subseteq 1..MaxAttempts
          /\ status \in {"queued", "running", "waiting"} \cup Terminal
          /\ attempt \in 0..MaxAttempts
          /\ cancelAccepted \in BOOLEAN
          /\ acceptedAttempt \in 0..MaxAttempts
CancelledStable == cancelAccepted => status = "cancelled"
StaleCannotComplete == status = "succeeded" => acceptedAttempt = attempt
==================================================================
