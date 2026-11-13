<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$stmt = $pdo->prepare('SELECT email FROM accounts WHERE id = ?');
$stmt->execute([$_GET['id']]);
