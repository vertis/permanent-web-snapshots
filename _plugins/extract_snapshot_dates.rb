require 'nokogiri'
require 'yaml'
Jekyll::Hooks.register :site, :after_init do |_site, _payload|
  puts "Extracting snapshot dates..."
  # Define the paths
  html_folder = "snapshots"  # Replace with your actual static files folder if different
  yaml_file = "_data/snapshot_dates.yml"  # This is where the YAML file will be saved

  # Initialize an empty hash to store filenames and dates
  date_hash = {}

  # Loop through each HTML file in the directory
  Dir["#{html_folder}/*.html"].each do |filepath|
    filename = File.basename(filepath)

    # Extract date from filename
    date_match = filename.match(/-(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}.\d{3}Z)/)
    date = date_match ? date_match[1] : nil

    # Convert the date string to an actual DateTime object for sorting
    date = DateTime.parse(date.gsub!('_', ':')) if date

    # Add to hash
    date_hash[filename] = date
  end

  # Write hash to a YAML file
  File.open(yaml_file, 'w') { |file| file.write(date_hash.to_yaml) }
end
