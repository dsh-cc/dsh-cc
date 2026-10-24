-------------------------- MODULE Model --------------------------
EXTENDS Naturals
CONSTANT MaxAttempts
ASSUME MaxAttempts \in Nat \ {0}
VARIABLES status, attempt, cancelAccepted, acceptedAttempt
vars == <<status, attempt, cancelAccepted, acceptedAttempt>>
Terminal == {"cancelled", "succeeded", "failed"}
Init == /\ status = "queued"
        /\ attempt = 0
        /\ cancelAccepted = FALSE
        /\ acceptedAttempt = 0
Start == /\ status = "queued"
         /\ status' = "running"
         /\ attempt' = 1
         /\ UNCHANGED <<cancelAccepted, acceptedAttempt>>
Timeout == /\ status = "running"
           /\ status' = IF attempt < MaxAttempts THEN "waiting" ELSE "failed"
           /\ UNCHANGED <<attempt, cancelAccepted, acceptedAttempt>>
Retry == /\ status = "waiting"
         /\ attempt < MaxAttempts
         /\ status' = "running"
         /\ attempt' = attempt + 1
         /\ UNCHANGED <<cancelAccepted, acceptedAttempt>>
Cancel == /\ status \notin Terminal
          /\ status' = "cancelled"
          /\ cancelAccepted' = TRUE
          /\ UNCHANGED <<attempt, acceptedAttempt>>
CompleteCurrent == /\ status = "running"
                   /\ status' = "succeeded"
                   /\ acceptedAttempt' = attempt
                   /\ UNCHANGED <<attempt, cancelAccepted>>
CompleteStale == /\ status = "running"
                 /\ attempt > 1
                 /\ status' = "succeeded"
                 /\ acceptedAttempt' = attempt - 1
                 /\ UNCHANGED <<attempt, cancelAccepted>>
TerminalStutter == /\ status \in Terminal
                   /\ UNCHANGED vars
Next == Start \/ Timeout \/ Retry \/ Cancel \/ CompleteCurrent
        \/ CompleteStale \/ TerminalStutter
Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"queued", "running", "waiting"} \cup Terminal
          /\ attempt \in 0..MaxAttempts
          /\ cancelAccepted \in BOOLEAN
          /\ acceptedAttempt \in 0..MaxAttempts
CancelledStable == cancelAccepted => status = "cancelled"
StaleCannotComplete == status = "succeeded" => acceptedAttempt = attempt
==================================================================
