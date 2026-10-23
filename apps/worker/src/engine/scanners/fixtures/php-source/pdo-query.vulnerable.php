<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$id = $_GET['id'];
$sql = 'SELECT email FROM accounts WHERE id=' . $id;
$pdo->query($sql);
