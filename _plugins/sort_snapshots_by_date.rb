require 'nokogiri'
require 'yaml'
Jekyll::Hooks.register :site, :after_init do |_site, _payload|
  puts "Sorting snapshots by date..."
  # Define the paths
  html_folder = "snapshots"  # Replace with your actual static files folder if different
  yaml_file = "_data/sorted_snapshot_dates.yml"  # This is where the YAML file will be saved

  # Initialize an empty array to store filenames with dates
  snapshots_with_dates = []

  # Loop through each HTML file in the directory
  Dir["#{html_folder}/*.html"].each do |filepath|
    filename = File.basename(filepath)

    # Extract date from filename
    date_match = filename.match(/-(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}.\d{3}Z)/)
    date = date_match ? date_match[1] : nil

    # Convert the date string to an actual DateTime object for sorting, if date is not nil
    if date
      date = DateTime.parse(date.gsub('_', ':'))
    else
      # Assign a very old date to ensure files without a date are sorted to the start of the list
      date = DateTime.new(0)
    end

    # Add to array
    snapshots_with_dates << { filename: filename, date: date }
  end

  # Sort the array by date, ensuring nil dates are handled
  sorted_snapshots = snapshots_with_dates.sort_by { |snapshot| snapshot[:date] }.map { |snapshot| snapshot[:filename] }

  # Write sorted array to a YAML file
  File.open(yaml_file, 'w') { |file| file.write(sorted_snapshots.to_yaml) }
end
