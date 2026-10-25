---- MODULE Model ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = 1
TypeOK == IF x = 0 THEN TRUE ELSE (1 \div 0) = 0
Spec == Init /\ [][Next]_x
====
