<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$host = $_GET['host'];
$argument = escapeshellarg($host);
system('ping -c 1 ' . $argument);
