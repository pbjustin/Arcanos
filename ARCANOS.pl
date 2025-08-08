#!/usr/bin/perl

# ARCANOS Internal Feedback Loop Monitor
# This script monitors the last GPT request and provides feedback to the system

use strict;
use warnings;

# Configuration
my $FEEDBACK_FILE = '/tmp/last-gpt-request';
my $LOG_DIR = $ENV{'ARC_LOG_PATH'} || '/tmp/arc/log';
my $LOG_FILE = "$LOG_DIR/feedback.log";
my $ARCANOS_ENDPOINT = 'http://localhost:8080/ask';

# Fallback log file if ARC_LOG_PATH is not accessible
my $FALLBACK_LOG = './memory/feedback.log';

# Ensure log directory exists
sub ensure_log_dir {
    my ($dir) = @_;
    unless (-d $dir) {
        system("mkdir -p '$dir'");
        return $? == 0;
    }
    return 1;
}

sub log_message {
    my ($message) = @_;
    my ($sec,$min,$hour,$mday,$mon,$year) = localtime(time);
    my $timestamp = sprintf "%04d-%02d-%02d %02d:%02d:%02d", $year+1900, $mon+1, $mday, $hour, $min, $sec;
    my $log_entry = "[$timestamp] [ARCANOS.pl] $message\n";
    
    print $log_entry;
    
    # Try to write to primary log, fallback to local if needed
    if (ensure_log_dir($LOG_DIR) && open(my $fh, '>>', $LOG_FILE)) {
        print $fh $log_entry;
        close($fh);
    } else {
        # Create fallback directory if needed
        system('mkdir -p ./memory') unless -d './memory';
        if (open(my $fh, '>>', $FALLBACK_LOG)) {
            print $fh $log_entry;
            close($fh);
        }
    }
}

sub read_file {
    my ($filename) = @_;
    return '' unless -f $filename;
    
    open(my $fh, '<', $filename) or return '';
    my $content = do { local $/; <$fh> };
    close($fh);
    return $content || '';
}

sub monitor_feedback_loop {
    log_message("Starting ARCANOS feedback loop monitor");
    
    if (-f $FEEDBACK_FILE) {
        my $content = read_file($FEEDBACK_FILE);
        chomp $content;
        
        if ($content) {
            log_message("Processing feedback: $content");
            
            # Send feedback to ARCANOS for analysis using curl
            # Escape content for JSON
            $content =~ s/"/\\"/g;
            $content =~ s/\n/\\n/g;
            
            my $curl_cmd = qq{curl -s -X POST "$ARCANOS_ENDPOINT" -H "Content-Type: application/json" -d '{"prompt": "SYSTEM FEEDBACK: Analyze recent request - $content"}'};
            my $response = `$curl_cmd`;
            
            if ($? == 0) {
                log_message("Feedback sent successfully to ARCANOS");
                log_message("Response: " . substr($response, 0, 200) . "...");
                
                # Clear the feedback file after processing
                unlink $FEEDBACK_FILE;
            } else {
                log_message("Failed to send feedback via curl");
            }
        }
    } else {
        log_message("No feedback file found at $FEEDBACK_FILE");
    }
}

sub main {
    log_message("ARCANOS.pl feedback monitor started");
    monitor_feedback_loop();
    log_message("ARCANOS.pl feedback monitor completed");
}

# Run the main function
main();

exit 0;