require 'nokogiri'
require 'yaml'
Jekyll::Hooks.register :site, :after_init do |_site, _payload|
  puts "Sorting snapshots by date and grouping..."
  # Define the paths
  html_folder = "snapshots"
  yaml_file = "_data/sorted_snapshot_dates.yml"

  # Initialize a hash to store filenames grouped by dates
  snapshots_grouped_by_dates = Hash.new { |hash, key| hash[key] = [] }

  # Loop through each HTML file in the directory
  Dir["#{html_folder}/*.html"].each do |filepath|
    filename = File.basename(filepath)

    # Extract date from filename
    date_match = filename.match(/[\-_](\d{4}-\d{2}-\d{2})T(\d{2})_(\d{2})_(\d{2}\.\d{3})Z/)
    date = date_match ? date_match[1] : "0000-00-00"

    # Convert the date string to an actual Date object for sorting, if date is not nil
    date = Date.parse(date)

    # Group by date
    snapshots_grouped_by_dates[date] << filename
  end

  # Sort the hash by date in reverse order and transform it into a hash
  sorted_and_grouped_snapshots = snapshots_grouped_by_dates.sort_by { |date, _filenames| date }.reverse.to_h

  # Write sorted and grouped hash to a YAML file
  File.open(yaml_file, 'w') { |file| file.write(sorted_and_grouped_snapshots.to_yaml) }
end
