<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$cart = json_decode($_COOKIE['cart'], true, 32, JSON_THROW_ON_ERROR);
